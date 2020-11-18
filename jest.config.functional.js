const mainJestConfig = require('./jest.config');

module.exports = {
  moduleFileExtensions: mainJestConfig.moduleFileExtensions,
  preset: mainJestConfig.preset,
  roots: ['src/functional_tests'],
  testEnvironment: mainJestConfig.testEnvironment,
  setupFilesAfterEnv: [
    ...mainJestConfig.setupFilesAfterEnv,
    './src/functional_tests/jest.setup.ts',
  ],
};
