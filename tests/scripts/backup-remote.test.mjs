import assert from "node:assert/strict"
import { test } from "node:test"
import { parseBackupRemoteArgs, referencedRoles } from "../../scripts/db/backup-remote.mjs"
import { EXIT } from "../../scripts/lib/exit-codes.mjs"

// El recorrido completo (snapshot, ensayo en copia desechable y recibo aceptado por la adopción)
// está en promotion-stack.test.mjs (escenario 11), con Docker.

test("db:backup remoto: solo preprod/prod, --expect-project obligatorio y sin URLs ni flags ajenos", () => {
  assert.deepEqual(parseBackupRemoteArgs(["prod", "--expect-project", "abcdefghijklmnopqrst"]), { target: "prod", json: false, expectProject: "abcdefghijklmnopqrst" })
  assert.equal(parseBackupRemoteArgs(["preprod", "--json", "--expect-project", "abcdefghijklmnopqrst"]).json, true)
  for (const args of [["local", "--expect-project", "x"], ["prod"], ["prod", "--db-url", "postgres://x"], ["prod", "--expect-project", "a", "--expect-project", "b"], ["prod", "--expect-project"]]) {
    assert.throws(() => parseBackupRemoteArgs(args), { code: EXIT.INVALID_ARGS })
  }
})

test("roles citados por el volcado: propietarios, grants, revokes y políticas, sin PUBLIC", () => {
  const dump = [
    'ALTER TABLE "biblib"."books" OWNER TO "postgres";',
    'GRANT SELECT ON TABLE "biblib"."books" TO "authenticated";',
    'GRANT USAGE ON SCHEMA "biblib" TO anon, "service_role";',
    'REVOKE ALL ON FUNCTION "biblib"."f"() FROM PUBLIC;',
    'CREATE POLICY "p" ON "biblib"."books" TO "supabase_auth_admin" USING (true);',
  ].join("\n")
  assert.deepEqual(referencedRoles(dump), ["anon", "authenticated", "postgres", "service_role", "supabase_auth_admin"])
})
