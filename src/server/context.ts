/** Shared singletons + assembled view-model builders for the HTTP routes. */
import { RankedClient } from "../api/client.js";
import { RankedApi } from "../api/endpoints.js";
import { Store } from "../db/db.js";

export class AppContext {
  readonly store: Store;
  readonly api: RankedApi;

  constructor(dbPath: string, privateKey: string | null) {
    this.store = new Store(dbPath);
    this.api = new RankedApi(new RankedClient({ privateKey }));
  }
}
