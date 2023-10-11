import envVar from 'env-var';

import { MONGODB_URI } from './db';

export interface EnvVarSet {
  readonly [key: string]: string | undefined;
}

export type EnvVarMocker = (envVars: EnvVarSet) => void;

export const REQUIRED_ENV_VARS = {
  GATEWAY_VERSION: '1.0.2',
  MONGODB_URI,
};

export function configureMockEnvVars(envVars: EnvVarSet = {}): EnvVarMocker {
  const mockEnvVarGet = jest.spyOn(envVar, 'get');

  function setEnvVars(newEnvVars: EnvVarSet): void {
    mockEnvVarGet.mockReset();
    mockEnvVarGet.mockImplementation((...args: readonly any[]) => {
      const originalEnvVar = jest.requireActual('env-var');
      const env = originalEnvVar.from(newEnvVars);

      return env.get(...args);
    });
  }

  beforeAll(() => setEnvVars(envVars));
  beforeEach(() => setEnvVars(envVars));

  afterAll(() => {
    mockEnvVarGet.mockRestore();
  });

  return (newEnvVars: EnvVarSet) => setEnvVars(newEnvVars);
}
