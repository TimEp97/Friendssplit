/** Fehler, der als verständliche JSON-Antwort an die App geht. */
export class ApiError extends Error {
  /**
   * @param {number} status HTTP-Status
   * @param {string} code maschinenlesbarer Fehlercode
   * @param {string} message Meldung für die Oberfläche
   * @param {{fields?: Record<string,string>, data?: object}} [extra] Feldfehler für Formulare bzw. Zusatzdaten
   */
  constructor(status, code, message, { fields = null, data = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.data = data;
  }

  /** @param {Record<string,string>} fields Feldname → Fehlermeldung */
  static validation(fields) {
    return new ApiError(422, 'validation', 'Bitte prüfe die markierten Eingaben.', { fields });
  }

  toJSON() {
    const error = { code: this.code, message: this.message };
    if (this.fields && Object.keys(this.fields).length) error.fields = this.fields;
    if (this.data) error.data = this.data;
    return { ok: false, error };
  }
}
