module.exports = {
  mongodbMemoryServerOptions: {
    binary: {
      version: '6.0.3',
      skipMD5: false,
    },
    instance: {},
    autoStart: false,
  },
  useSharedDBForAllJestWorkers: false,
};
