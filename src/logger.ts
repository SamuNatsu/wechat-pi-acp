import pino from "pino";

const root = pino({
  level: "info",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:HH:MM:ss",
      ignore: "pid,hostname",
    },
  },
});

export function setVerbose(v: boolean): void {
  root.level = v ? "debug" : "info";
}

export function createLogger(name: string): pino.Logger {
  return root.child({ name });
}
