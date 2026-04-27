import { faker } from "@faker-js/faker";

export function makeSessionId(): string {
  return faker.string.alphanumeric(12);
}

export function makeTranscriptChunk(overrides?: Record<string, unknown>) {
  return {
    text: faker.lorem.sentence(),
    speakerId: faker.person.firstName(),
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

export function makeTag(overrides?: Record<string, unknown>) {
  return {
    label: faker.lorem.words(2),
    ...overrides,
  };
}

export function makeContext(overrides?: Record<string, string>) {
  return {
    context: {
      role: faker.person.jobTitle(),
      notes: faker.lorem.sentence(),
      ...overrides,
    },
  };
}
