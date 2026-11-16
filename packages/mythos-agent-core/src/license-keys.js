// The public keys that licence keys are checked against, and licence ids that
// have been withdrawn. Public keys are safe to publish; the matching private
// key is the owner's alone and must never be in this repository.
//
// Empty list = no licence can verify, so every tool marked `tier: 'pro'` stays
// locked. To switch licensing on:
//   1. npx -p mythos-agent-core mythos-license keygen --out <a folder outside any repo>
//   2. paste the printed public key block into LICENSE_PUBLIC_KEYS below
//   3. publish a release that carries it
// Keep an old key in the list for as long as licences signed with it should work.
//
// There is deliberately no environment variable or config file that adds a
// trusted key: a host that could set one could sign its own licence.

export const LICENSE_PUBLIC_KEYS = [
  // `-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n`,
];

// Licence ids (the "id" field) that no longer count, e.g. after a refund.
// An offline check cannot phone home, so a withdrawal only takes effect in
// releases that list the id here.
export const LICENSE_REVOKED_IDS = [];
