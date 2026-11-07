import test from "node:test";
import assert from "node:assert/strict";
import { getVaultRecord, storageAvailable } from "../turso";

test("vault storage fails closed when neither durable storage nor test mode is configured", async () => {
  const previousTurso = process.env.TURSO_DATABASE_URL;
  const previousMemory = process.env.VAULT_MEMORY_STORE;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.VAULT_MEMORY_STORE;
  try {
    assert.equal(storageAvailable(), false);
    await assert.rejects(
      () => getVaultRecord("any-vault"),
      /Durable vault storage is not configured/
    );
  } finally {
    if (previousTurso !== undefined) process.env.TURSO_DATABASE_URL = previousTurso;
    if (previousMemory !== undefined) process.env.VAULT_MEMORY_STORE = previousMemory;
  }
});

test("the in-memory store is only selected by the explicit test flag", async () => {
  const previousTurso = process.env.TURSO_DATABASE_URL;
  const previousMemory = process.env.VAULT_MEMORY_STORE;
  delete process.env.TURSO_DATABASE_URL;
  process.env.VAULT_MEMORY_STORE = "1";
  try {
    assert.equal(storageAvailable(), true);
    assert.equal(await getVaultRecord("absent-vault"), null);
  } finally {
    if (previousTurso !== undefined) process.env.TURSO_DATABASE_URL = previousTurso;
    else delete process.env.TURSO_DATABASE_URL;
    if (previousMemory !== undefined) process.env.VAULT_MEMORY_STORE = previousMemory;
    else delete process.env.VAULT_MEMORY_STORE;
  }
});
