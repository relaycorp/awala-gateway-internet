const mainJestConfig = require('../../jest.config');

module.exports = {
  moduleFileExtensions: mainJestConfig.moduleFileExtensions,
  preset: mainJestConfig.preset,
  roots: ['.'],
  testEnvironment: mainJestConfig.testEnvironment,
  setupFilesAfterEnv: [
    ...mainJestConfig.setupFilesAfterEnv,
    './jest.setup.ts',
  ],
};
