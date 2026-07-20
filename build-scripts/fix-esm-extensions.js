const fs = require('fs');
const path = require('path');

function getAllFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      getAllFiles(filePath, fileList);
    } else if (file.endsWith('.js')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

/**
 * Resolve a relative import path to its actual on-disk ESM target.
 * Handles three cases the TypeScript compiler emits for extensionless
 * imports under `module: esnext`:
 *   - `./foo`      → `./foo.js`         (file exists)
 *   - `./foo`      → `./foo/index.js`   (directory with index.js)
 *   - `./foo.js`   → unchanged
 * Returns null if no resolution applies (caller leaves the import alone).
 */
function resolveEsmImport(fromDir, relativePath) {
  if (relativePath.endsWith('.js')) return relativePath;
  const absBase = path.resolve(fromDir, relativePath);
  if (fs.existsSync(`${absBase}.js`)) return `${relativePath}.js`;
  if (fs.existsSync(path.join(absBase, 'index.js'))) {
    return `${relativePath}/index.js`;
  }
  return null;
}

function fixESMExtensions(dir) {
  const files = getAllFiles(dir);
  let fixedCount = 0;

  for (const file of files) {
    let content = fs.readFileSync(file, 'utf-8');
    const originalContent = content;
    const fileDir = path.dirname(file);

    // Fix import statements
    content = content.replace(
      /import\s+([\s\S]*?)\s+from\s+['"](\.+\/[^'"]+)['"]/g,
      (match, imports, relativePath) => {
        const resolved = resolveEsmImport(fileDir, relativePath);
        return resolved ? `import ${imports} from '${resolved}'` : match;
      }
    );

    // Fix export statements (re-exports)
    content = content.replace(
      /export\s+{([\s\S]*?)}\s+from\s+['"](\.\/[^'"]+)['"]/g,
      (match, exports, relativePath) => {
        const resolved = resolveEsmImport(fileDir, relativePath);
        return resolved ? `export {${exports}} from '${resolved}'` : match;
      }
    );

    // Only write if content changed
    if (content !== originalContent) {
      fs.writeFileSync(file, content);
      fixedCount++;
    }
  }

  console.log(`Fixed ESM extensions in ${fixedCount} files`);
}

const esmDir = path.join(__dirname, '..', 'dist', 'esm');
fixESMExtensions(esmDir);
