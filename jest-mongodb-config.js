module.exports = {
  mongodbMemoryServerOptions: {
    binary: {
      version: '4.4.18',
      skipMD5: false,
    },
    instance: {},
    autoStart: false,
  },
  useSharedDBForAllJestWorkers: false,
};
