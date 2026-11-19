// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/** The provider and its access rules have not yet been verified. */
export async function queryAccountCatalog(): Promise<{grants:false;pageNo:number;pageSize:number;items:[]}> {
  throw Object.assign(new Error('Cloud catalog unavailable.'), {code:'catalog-unconfirmed'});
}
