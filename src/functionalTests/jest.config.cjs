const mainJestConfig = require('../../jest.config.cjs');

module.exports = {
  moduleFileExtensions: mainJestConfig.moduleFileExtensions,
  preset: 'ts-jest',
  roots: ['.'],
  testEnvironment: 'node',
  setupFilesAfterEnv: [...mainJestConfig.setupFilesAfterEnv, './jest.setup.ts'],
};
