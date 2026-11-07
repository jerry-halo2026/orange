// Generated from schemas/K07/v1.schema.json by tools/contracts/generate.mjs; do not edit.
export const K07_KEY = "K07.desktop-startup.v1";
export const K07_FIELDS = {
  "schemaVersion": {
    "type": "integer",
    "const": 1
  },
  "eventName": {
    "enum": [
      "desktop.shell.start.begin",
      "desktop.shell.start.finish"
    ]
  },
  "component": {
    "const": "desktop.main"
  },
  "timestamp": {
    "type": "string",
    "pattern": "^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z(?![\\s\\S])",
    "format": "date-time"
  },
  "traceId": {
    "type": "string",
    "pattern": "^(?!0{32}(?![\\s\\S]))[0-9a-f]{32}(?![\\s\\S])"
  },
  "eventId": {
    "type": "string",
    "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\\s\\S])"
  },
  "environment": {
    "const": "local"
  },
  "appVersion": {
    "type": "string",
    "pattern": "^(?:0|[1-9][0-9]{0,8})(?:\\.(?:0|[1-9][0-9]{0,8})){2}(?![\\s\\S])"
  },
  "buildCommit": {
    "type": "string",
    "pattern": "^[0-9a-f]{40}(?![\\s\\S])"
  },
  "severity": {
    "enum": [
      "info",
      "error"
    ]
  },
  "outcome": {
    "enum": [
      "ok",
      "failed"
    ]
  },
  "durationMs": {
    "type": "integer",
    "minimum": 0,
    "maximum": 9007199254740991
  },
  "errorCode": {
    "enum": [
      "SHELL_START_FAILED",
      "SHELL_LOAD_FAILED"
    ]
  }
} as const;
export const K07_SHAPES = [
  {
    "title": "begin",
    "eventName": "desktop.shell.start.begin",
    "severity": "info",
    "outcome": null,
    "required": [
      "schemaVersion",
      "eventName",
      "component",
      "timestamp",
      "traceId",
      "eventId",
      "environment",
      "appVersion",
      "buildCommit",
      "severity"
    ]
  },
  {
    "title": "finishOk",
    "eventName": "desktop.shell.start.finish",
    "severity": "info",
    "outcome": "ok",
    "required": [
      "schemaVersion",
      "eventName",
      "component",
      "timestamp",
      "traceId",
      "eventId",
      "environment",
      "appVersion",
      "buildCommit",
      "severity",
      "outcome",
      "durationMs"
    ]
  },
  {
    "title": "finishFailed",
    "eventName": "desktop.shell.start.finish",
    "severity": "error",
    "outcome": "failed",
    "required": [
      "schemaVersion",
      "eventName",
      "component",
      "timestamp",
      "traceId",
      "eventId",
      "environment",
      "appVersion",
      "buildCommit",
      "severity",
      "outcome",
      "durationMs",
      "errorCode"
    ]
  }
] as const;
export const K07_DIAGNOSTICS = {
  "frame": {
    "maxLineBytes": 768,
    "maxRecords": 4,
    "eofDeadlineMs": 12000
  },
  "failure": {
    "startup": "SHELL_START_FAILED",
    "loadFile": "SHELL_LOAD_FAILED",
    "category": "system",
    "retryable": false
  },
  "errors": {
    "version": {
      "code": "CONTRACT_VERSION",
      "path": "$.schemaVersion"
    },
    "field": {
      "code": "CONTRACT_FIELD",
      "pathPrefix": "$."
    },
    "shape": {
      "code": "CONTRACT_SHAPE",
      "path": "$"
    },
    "frame": {
      "code": "DIAGNOSTIC_FRAME",
      "path": "$frame"
    },
    "conflict": {
      "code": "DIAGNOSTIC_CONFLICT",
      "path": "$stream"
    },
    "mismatch": {
      "code": "DIAGNOSTIC_MISMATCH",
      "path": "$stream"
    },
    "incomplete": {
      "code": "DIAGNOSTIC_INCOMPLETE",
      "path": "$stream"
    }
  }
} as const;
export type K07Record = {
  readonly schemaVersion: 1;
  readonly eventName: "desktop.shell.start.begin";
  readonly component: "desktop.main";
  readonly timestamp: string;
  readonly traceId: string;
  readonly eventId: string;
  readonly environment: "local";
  readonly appVersion: string;
  readonly buildCommit: string;
  readonly severity: "info";
  readonly outcome?: never;
  readonly durationMs?: never;
  readonly errorCode?: never;
} | {
  readonly schemaVersion: 1;
  readonly eventName: "desktop.shell.start.finish";
  readonly component: "desktop.main";
  readonly timestamp: string;
  readonly traceId: string;
  readonly eventId: string;
  readonly environment: "local";
  readonly appVersion: string;
  readonly buildCommit: string;
  readonly severity: "info";
  readonly outcome: "ok";
  readonly durationMs: number;
  readonly errorCode?: never;
} | {
  readonly schemaVersion: 1;
  readonly eventName: "desktop.shell.start.finish";
  readonly component: "desktop.main";
  readonly timestamp: string;
  readonly traceId: string;
  readonly eventId: string;
  readonly environment: "local";
  readonly appVersion: string;
  readonly buildCommit: string;
  readonly severity: "error";
  readonly outcome: "failed";
  readonly durationMs: number;
  readonly errorCode: "SHELL_START_FAILED" | "SHELL_LOAD_FAILED";
};
