const mainJestConfig = require('./jest.config');

module.exports = {
  moduleFileExtensions: ['js'],
  preset: mainJestConfig.preset,
  roots: ['build/main/functional_tests'],
  testEnvironment: mainJestConfig.testEnvironment,
  setupFilesAfterEnv: mainJestConfig.setupFilesAfterEnv
};
