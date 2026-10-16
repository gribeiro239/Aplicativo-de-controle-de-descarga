const numericText = (value: string) => value.replace(/[^0-9,.-]/g, "").trim();

export const parseBrazilianNumber = (value: string) => {
  const raw = numericText(value);
  if (!raw) return 0;
  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(/,(?=[^,]*$)/, ".").replace(/,/g, "")
    : raw;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const parseBrazilianWeight = (value: string) => {
  const raw = numericText(value);
  if (!raw) return 0;

  // Nas LCDs, um peso como "7.546" usa o ponto como separador de milhar.
  const normalized = /^-?\d{1,3}(?:\.\d{3})+$/.test(raw)
    ? raw.replace(/\./g, "")
    : raw;

  return parseBrazilianNumber(normalized);
};
