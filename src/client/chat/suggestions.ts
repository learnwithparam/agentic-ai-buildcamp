// Questions a doctor might ask, for the signed-in doctor's own company. Each one shows a
// different part of the agent.
// src/client/chat/suggestions.test.ts holds each list to its own company's medicines.
export const SUGGESTIONS: Record<string, string[]> = {
  pharma_a: [
    "What is the CardioNex dose for a US patient with eGFR 24 who is not on dialysis?",
    "Draft a reply to Dr. Lee in Germany: what CardioNex dose fits a patient with eGFR 24?",
    "What is the approved use of CardioNex in Japan?"
  ],
  pharma_b: [
    "What is the recommended NeuroVex dose for diabetic peripheral neuropathy?",
    "In the NeuroVex trial, how many patients stopped because of dizziness?",
    "Draft a reply to Dr. Patel: what NeuroVex dose should an adult start on?"
  ]
};
