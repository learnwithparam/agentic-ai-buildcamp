// Invented prescribers. The numbers start with 1999 so no real doctor can match one.
// Names and emails exist to be protected: no answer and no trace may ever hold them.
import { seededRandom } from "./random";

export type Prescriber = {
  name: string;
  npi: string;
  email: string;
  specialty: string;
  territory: string;
};

const FIRST = [
  "Amara",
  "Hiroshi",
  "Lucia",
  "Priyanka",
  "Tomas",
  "Ngozi",
  "Elif",
  "Sven",
  "Marisol",
  "Dae-jung",
];
const LAST = [
  "Okafor",
  "Tanaka",
  "Fernandez",
  "Nair",
  "Novak",
  "Eze",
  "Yilmaz",
  "Lindqvist",
  "Ortega",
  "Park",
];
const SPECIALTIES = ["oncology", "cardiology", "pulmonology", "general practice"];
export const TERRITORIES = [
  "Pacific Northwest",
  "Great Lakes",
  "Texas Triangle",
  "Mid-Atlantic",
  "New England",
  "Florida Gulf",
  "Rocky Mountain",
  "Southern California",
];

function buildPrescribers(): Prescriber[] {
  const random = seededRandom(1999);
  const made: Prescriber[] = [];
  for (let index = 0; index < 40; index++) {
    const first = FIRST[index % FIRST.length];
    const last = LAST[(index * 7 + Math.floor(index / 10)) % LAST.length];
    const digits = String(Math.floor(random() * 1_000_000)).padStart(6, "0");
    made.push({
      name: `Dr ${first} ${last}`,
      npi: `1999${digits}`,
      email: `${first}.${last}@clinic.example.test`.toLowerCase(),
      specialty: SPECIALTIES[index % SPECIALTIES.length],
      territory: TERRITORIES[index % TERRITORIES.length],
    });
  }
  return made;
}

export const PRESCRIBERS: Prescriber[] = buildPrescribers();
