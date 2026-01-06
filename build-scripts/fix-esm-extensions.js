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

function fixESMExtensions(dir) {
  const files = getAllFiles(dir);
  let fixedCount = 0;

  for (const file of files) {
    let content = fs.readFileSync(file, 'utf-8');
    const originalContent = content;

    // Fix import statements
    content = content.replace(
      /import\s+([\s\S]*?)\s+from\s+['"](\.+\/[^'"]+)['"]/g,
      (match, imports, relativePath) => {
        if (!relativePath.endsWith('.js')) {
          return `import ${imports} from '${relativePath}.js'`;
        }
        return match;
      }
    );

    // Fix export statements (re-exports)
    content = content.replace(
      /export\s+{([\s\S]*?)}\s+from\s+['"](\.\/[^'"]+)['"]/g,
      (match, exports, relativePath) => {
        if (!relativePath.endsWith('.js')) {
          return `export {${exports}} from '${relativePath}.js'`;
        }
        return match;
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
