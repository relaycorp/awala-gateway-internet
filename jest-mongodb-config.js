module.exports = {
  mongodbMemoryServerOptions: {
    binary: {
      version: '4.2.17',
      skipMD5: false,
    },
    instance: {},
    autoStart: false,
  },
  useSharedDBForAllJestWorkers: false,
};
