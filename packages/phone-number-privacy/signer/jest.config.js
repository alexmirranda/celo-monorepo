module.exports = {
  preset: 'ts-jest',
  setupFiles: ['dotenv/config'],
  coverageReporters: [['lcov', { projectRoot: '../../../' }], 'text'],
  collectCoverageFrom: ['./src/**'],
  coverageThreshold: {
    global: {
      lines: 76,
    },
  },
}
