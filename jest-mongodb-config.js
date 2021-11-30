module.exports = {
  mongodbMemoryServerOptions: {
    binary: {
      version: '4.0.3',
      skipMD5: false,
    },
    instance: {},
    autoStart: false,
  },
  useSharedDBForAllJestWorkers: false,
};
