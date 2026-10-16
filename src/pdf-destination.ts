export const parsePdfDestination = (value: string, labeledCode = "") => {
  const trimmedValue = value.trim();
  const trimmedCode = labeledCode.trim();
  const combinedMatch = trimmedValue.match(/^(\d[\d./-]*)\s+(.+)$/);

  if (combinedMatch) {
    return {
      destinationCode: trimmedCode || combinedMatch[1].trim(),
      destinationName: combinedMatch[2].trim(),
    };
  }

  const nameWithoutCode = trimmedCode
    ? trimmedValue.replace(new RegExp(`^${trimmedCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`), "").trim()
    : trimmedValue;

  return { destinationCode: trimmedCode, destinationName: nameWithoutCode };
};
