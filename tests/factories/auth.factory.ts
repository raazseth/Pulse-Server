import { faker } from "@faker-js/faker";

export interface RegisterPayload {
  email: string;
  password: string;
  name: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}

export function makeRegisterPayload(overrides?: Partial<RegisterPayload>): RegisterPayload {
  return {
    email: faker.internet.email(),
    password: faker.internet.password({ length: 12 }),
    name: faker.person.fullName(),
    ...overrides,
  };
}

export function makeLoginPayload(email: string, password: string): LoginPayload {
  return { email, password };
}
