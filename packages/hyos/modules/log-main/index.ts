import { app } from "electron";
import { defineModule } from "../../runtime.js";
import { createLogSink, type LogSink } from "./sink.js";

export = defineModule({
  id: "log.main",
  inject: [],
  provide: ["log.sink"],

  apply(ctx) {
    const sink: LogSink = createLogSink({
      directory: app.getPath("logs"),
    });
    ctx.provide("log.sink", sink);
    sink.log("info", "main", "log sink started");
  },
});
