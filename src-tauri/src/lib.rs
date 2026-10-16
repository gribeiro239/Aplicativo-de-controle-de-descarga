use serde::{Deserialize, Serialize};
use std::{env, fs, path::{Path, PathBuf}};
use tauri_plugin_sql::{Migration, MigrationKind};

const REQUEST_SUFFIX: &str = ".request.json";
const PROCESSING_SUFFIX: &str = ".processing.json";

#[derive(Deserialize)]
struct BotRequestFile {
    pdf_path: String,
    file_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BotRequestClaim {
    request_id: String,
    file_name: String,
    pdf_bytes: Vec<u8>,
}

#[derive(Serialize)]
struct BotResponse<'a> {
    score: Option<i32>,
    resultado: &'a str,
}

fn integration_root() -> Result<PathBuf, String> {
    if let Some(configured) = env::var_os("APP_DESCARGA_INTEGRATION_DIR") {
        return Ok(PathBuf::from(configured));
    }
    let local_app_data = env::var_os("LOCALAPPDATA")
        .ok_or_else(|| "A variavel LOCALAPPDATA nao esta disponivel.".to_string())?;
    Ok(PathBuf::from(local_app_data).join("APP Descarga").join("integracao"))
}

fn valid_request_id(request_id: &str) -> bool {
    !request_id.is_empty()
        && request_id.len() <= 80
        && request_id.chars().all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
}

fn prepare_integration_directories(root: &Path) -> Result<(), String> {
    for directory in ["entrada", "processando", "respostas", "logs"] {
        fs::create_dir_all(root.join(directory))
            .map_err(|error| format!("Nao foi possivel preparar a integracao: {error}"))?;
    }
    Ok(())
}

fn write_bot_response(
    root: &Path,
    request_id: &str,
    score: Option<i32>,
    resultado: &str,
    error_detail: Option<&str>,
) -> Result<(), String> {
    if !valid_request_id(request_id) {
        return Err("Identificador de solicitacao invalido.".to_string());
    }
    prepare_integration_directories(root)?;
    let response_path = root.join("respostas").join(format!("{request_id}.json"));
    let temporary_path = root.join("respostas").join(format!("{request_id}.tmp"));
    let payload = serde_json::to_vec_pretty(&BotResponse { score, resultado })
        .map_err(|error| format!("Nao foi possivel montar a resposta: {error}"))?;
    fs::write(&temporary_path, payload)
        .map_err(|error| format!("Nao foi possivel gravar a resposta: {error}"))?;
    if response_path.exists() {
        fs::remove_file(&response_path)
            .map_err(|error| format!("Nao foi possivel substituir a resposta anterior: {error}"))?;
    }
    fs::rename(&temporary_path, &response_path)
        .map_err(|error| format!("Nao foi possivel publicar a resposta: {error}"))?;

    if let Some(detail) = error_detail {
        let log_path = root.join("logs").join(format!("{request_id}.log"));
        fs::write(log_path, detail)
            .map_err(|error| format!("Nao foi possivel gravar o log da integracao: {error}"))?;
    }
    Ok(())
}

fn request_id_from_path(path: &Path, suffix: &str) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let request_id = name.strip_suffix(suffix)?.to_string();
    valid_request_id(&request_id).then_some(request_id)
}

fn request_paths(directory: &Path, suffix: &str) -> Result<Vec<PathBuf>, String> {
    let mut paths = fs::read_dir(directory)
        .map_err(|error| format!("Nao foi possivel ler a fila da integracao: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| request_id_from_path(path, suffix).is_some())
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

#[tauri::command]
fn claim_bot_request() -> Result<Option<BotRequestClaim>, String> {
    let root = integration_root()?;
    prepare_integration_directories(&root)?;
    let input_directory = root.join("entrada");
    let processing_directory = root.join("processando");

    let mut candidates = request_paths(&processing_directory, PROCESSING_SUFFIX)?;
    if candidates.is_empty() {
        for input_path in request_paths(&input_directory, REQUEST_SUFFIX)? {
            let Some(request_id) = request_id_from_path(&input_path, REQUEST_SUFFIX) else { continue };
            let processing_path = processing_directory.join(format!("{request_id}{PROCESSING_SUFFIX}"));
            if fs::rename(&input_path, &processing_path).is_ok() {
                candidates.push(processing_path);
                break;
            }
        }
    }

    let Some(request_path) = candidates.into_iter().next() else { return Ok(None) };
    let request_id = request_id_from_path(&request_path, PROCESSING_SUFFIX)
        .ok_or_else(|| "Solicitacao com nome invalido.".to_string())?;

    let load = || -> Result<BotRequestClaim, String> {
        let contents = fs::read_to_string(&request_path)
            .map_err(|error| format!("Nao foi possivel ler a solicitacao: {error}"))?;
        let request: BotRequestFile = serde_json::from_str(&contents)
            .map_err(|error| format!("Solicitacao invalida: {error}"))?;
        let pdf_path = PathBuf::from(&request.pdf_path);
        if pdf_path.extension().and_then(|extension| extension.to_str()).map(|extension| extension.eq_ignore_ascii_case("pdf")) != Some(true) {
            return Err("A solicitacao nao aponta para um arquivo PDF.".to_string());
        }
        let metadata = fs::metadata(&pdf_path)
            .map_err(|error| format!("PDF nao encontrado: {error}"))?;
        if metadata.len() > 20 * 1024 * 1024 {
            return Err("O PDF excede o limite de 20 MB.".to_string());
        }
        let pdf_bytes = fs::read(&pdf_path)
            .map_err(|error| format!("Nao foi possivel ler o PDF: {error}"))?;
        let file_name = request.file_name
            .or_else(|| pdf_path.file_name().and_then(|name| name.to_str()).map(str::to_string))
            .unwrap_or_else(|| format!("{request_id}.pdf"));
        Ok(BotRequestClaim { request_id: request_id.clone(), file_name, pdf_bytes })
    };

    match load() {
        Ok(claim) => Ok(Some(claim)),
        Err(error) => {
            write_bot_response(&root, &request_id, None, "ERRO_NA_ANALISE", Some(&error))?;
            let _ = fs::remove_file(request_path);
            Ok(None)
        }
    }
}

#[tauri::command]
fn complete_bot_request(
    request_id: String,
    score: Option<i32>,
    resultado: String,
    error_detail: Option<String>,
) -> Result<(), String> {
    let root = integration_root()?;
    write_bot_response(&root, &request_id, score, &resultado, error_detail.as_deref())?;
    let marker = root.join("processando").join(format!("{request_id}{PROCESSING_SUFFIX}"));
    if marker.exists() {
        fs::remove_file(marker)
            .map_err(|error| format!("A resposta foi criada, mas a solicitacao nao foi encerrada: {error}"))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create_initial_schema",
            sql: include_str!("../migrations/0001_initial.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add_reimbursement_classification",
            sql: include_str!("../migrations/0002_reimbursement.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "add_cost_center_dimension",
            sql: include_str!("../migrations/0003_cost_center.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "add_financial_result_fields",
            sql: include_str!("../migrations/0004_financial_result.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "add_document_type",
            sql: include_str!("../migrations/0005_document_type.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:descarga.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![claim_bot_request, complete_bot_request])
        .run(tauri::generate_context!())
        .expect("falha ao iniciar o APP Descarga");
}
