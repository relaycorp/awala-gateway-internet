const mainJestConfig = require('./jest.config');

module.exports = {
  moduleFileExtensions: mainJestConfig.moduleFileExtensions,
  preset: mainJestConfig.preset,
  roots: ['src/functionalTests'],
  testEnvironment: mainJestConfig.testEnvironment,
  setupFilesAfterEnv: [
    ...mainJestConfig.setupFilesAfterEnv,
    './src/functionalTests/jest.setup.ts',
  ],
};
