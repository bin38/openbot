/** This fork owns its local workspace and does not sell the upstream vendor's cloud services. */
export const INDEPENDENT_EDITION = true;

/** Local identity is never a remote account session, authorization grant, or paid license. */
export interface LocalWorkspaceProfile {
  id: string;
  name: string;
}
