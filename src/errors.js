export class AppError extends Error {
  constructor(message, status = 400, code = "bad_request") {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

export class ShopifyError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ShopifyError";
    this.sent = Boolean(options.sent);
    this.applied = options.applied ?? false;
    this.userErrors = options.userErrors || null;
    this.code = options.code || "shopify";
    this.status = options.status || 0;
  }
}

export class LockLostError extends Error {
  constructor() {
    super("Die Datenbanksperre für den Zeitplaner ist verloren.");
    this.name = "LockLostError";
  }
}
