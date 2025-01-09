import * as log from '@std/log'

log.setup({
  handlers: {
    default: new log.ConsoleHandler('DEBUG', {
      formatter: (record) =>
        `[${record.datetime.toLocaleString()}] ` +
        `${record.levelName} ${record.msg}`,
      useColors: true,
    }),
  },
})

export default log
