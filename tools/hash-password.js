// Genera un hash bcrypt para usar en ADMIN_PASSWORD_HASH.
// Uso:  npm run hash -- "tu-contraseña"
import bcrypt from 'bcryptjs';

const password = process.argv[2];
if (!password) {
  console.error('Uso: npm run hash -- "tu-contraseña"');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);
console.log(hash);
