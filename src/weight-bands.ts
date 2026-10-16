export type WeightBand = {
  label: string;
  minExclusive: number;
  maxInclusive: number;
};

export const WEIGHT_BANDS: WeightBand[] = [
  { label: "0–100 kg", minExclusive: 0, maxInclusive: 100 },
  { label: "100–250 kg", minExclusive: 100, maxInclusive: 250 },
  { label: "250–500 kg", minExclusive: 250, maxInclusive: 500 },
  { label: "500–750 kg", minExclusive: 500, maxInclusive: 750 },
  { label: "750 kg–1 t", minExclusive: 750, maxInclusive: 1000 },
  { label: "1–1,5 t", minExclusive: 1000, maxInclusive: 1500 },
  { label: "1,5–2 t", minExclusive: 1500, maxInclusive: 2000 },
  { label: "2–3 t", minExclusive: 2000, maxInclusive: 3000 },
  { label: "3–4 t", minExclusive: 3000, maxInclusive: 4000 },
  { label: "4–5 t", minExclusive: 4000, maxInclusive: 5000 },
  { label: "5–8 t", minExclusive: 5000, maxInclusive: 8000 },
  { label: "8–10 t", minExclusive: 8000, maxInclusive: 10000 },
  { label: "Acima de 10 t", minExclusive: 10000, maxInclusive: Infinity },
];

export const weightBandFor = (weight: number) =>
  WEIGHT_BANDS.find((band) => weight > band.minExclusive && weight <= band.maxInclusive);

export const isInWeightBand = (weight: number, band: WeightBand) =>
  weight > band.minExclusive && weight <= band.maxInclusive;
