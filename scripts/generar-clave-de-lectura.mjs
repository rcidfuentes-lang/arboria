#!/usr/bin/env node
/**
 * Genera una clave de lectura para un proyecto e imprime el SQL que la da de
 * alta. No toca la base de datos, no lee ninguna credencial y no escribe
 * ningun fichero: imprime y termina.
 *
 *   node scripts/generar-clave-de-lectura.mjs <uuid-del-proyecto> "<etiqueta>"
 *
 * La clave se imprime una sola vez porque no se guarda en ninguna parte: en la
 * base solo entra su SHA-256. Si se pierde, se revoca esa fila y se genera otra.
 */
import { createHash, randomBytes } from 'node:crypto'

const [projectId, label] = process.argv.slice(2)

const esUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
if (!projectId || !esUuid.test(projectId) || !label) {
  console.error('Uso: node scripts/generar-clave-de-lectura.mjs <uuid-del-proyecto> "<etiqueta>"')
  console.error('')
  console.error('El uuid es roadmap_projects.id, no el slug ni document.project.id.')
  console.error('Se ve en Supabase Studio, en la tabla roadmap_projects.')
  process.exit(1)
}

// 32 bytes de aleatoriedad criptografica. base64url para que viaje en una
// cabecera Authorization sin escapar nada.
const clave = randomBytes(32).toString('base64url')
const hash = createHash('sha256').update(clave, 'utf8').digest('hex')

console.log('')
console.log('  Clave (se muestra una sola vez, no se guarda en ningun sitio):')
console.log('')
console.log(`    ${clave}`)
console.log('')
console.log('  SQL para darla de alta. Ejecutalo en el editor de Supabase Studio:')
console.log('')
console.log('    insert into public.roadmap_api_keys (project_id, key_hash, label)')
console.log(`    values ('${projectId}', '${hash}', ${JSON.stringify(label).replace(/"/g, "'")});`)
console.log('')
console.log('  Para probarla despues:')
console.log('')
console.log(`    curl -H "Authorization: Bearer ${clave}" https://<el-sitio>/api/roadmap`)
console.log('')
console.log('  Para revocarla, sin borrar el registro de que existio:')
console.log('')
console.log(`    update public.roadmap_api_keys set revoked_at = now() where key_hash = '${hash}';`)
console.log('')
