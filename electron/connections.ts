import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  https: boolean;
  pathPrefix?: string;
  username: string;
  namespace: string;
}

function connectionsFile() {
  return path.join(app.getPath("userData"), "connections.json");
}

function secretsFile() {
  return path.join(app.getPath("userData"), "secrets.json");
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function listConnections(): ConnectionProfile[] {
  return readJson(connectionsFile(), []);
}

export function saveConnection(
  profile: Omit<ConnectionProfile, "id"> & { id?: string },
  password?: string,
): ConnectionProfile {
  const connections = listConnections();
  const id = profile.id ?? crypto.randomUUID();
  const saved: ConnectionProfile = { ...profile, id };
  const index = connections.findIndex((connection) => connection.id === id);
  if (index >= 0) connections[index] = saved;
  else connections.push(saved);
  writeJson(connectionsFile(), connections);

  if (password !== undefined) {
    const secrets = readJson<Record<string, string>>(secretsFile(), {});
    if (safeStorage.isEncryptionAvailable()) {
      secrets[id] = safeStorage.encryptString(password).toString("base64");
      writeJson(secretsFile(), secrets);
    }
    // If OS-level encryption isn't available, the password is intentionally not persisted
    // rather than risk writing it in plaintext; the user will need to re-enter it next session.
  }
  return saved;
}

export function deleteConnection(id: string): void {
  writeJson(
    connectionsFile(),
    listConnections().filter((connection) => connection.id !== id),
  );
  const secrets = readJson<Record<string, string>>(secretsFile(), {});
  delete secrets[id];
  writeJson(secretsFile(), secrets);
}

export function getPassword(id: string): string | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  const secrets = readJson<Record<string, string>>(secretsFile(), {});
  const encoded = secrets[id];
  if (!encoded) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(encoded, "base64"));
  } catch {
    return undefined;
  }
}
