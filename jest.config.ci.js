const mainJestConfig = require('./jest.config');

module.exports = Object.assign({}, mainJestConfig, {
  collectCoverageFrom: ['services/**/*.js'],
  moduleFileExtensions: ['js'],
  preset: null,
  roots: ['build/main'],
  testPathIgnorePatterns: [
    "build/main/functional_tests"
  ],
});
