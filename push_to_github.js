/**
 * BioCloud IoT -> GitHub Direct Push Tool (No Git CLI installation required!)
 * 
 * This tool uses the official GitHub REST API to create a repository and
 * push all project files directly to your GitHub account.
 * 
 * Usage:
 *   node push_to_github.js <GITHUB_USERNAME> <GITHUB_TOKEN> [REPO_NAME]
 * 
 * Example:
 *   node push_to_github.js myusername ghp_xxxxxxxxxxxxxxxxxxxx BioCloud-IoT
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const username = process.argv[2];
const token = process.argv[3];
const repoName = process.argv[4] || 'biocloud-smart-healthcare-monitoring';

if (!username || !token) {
    console.log('========================================================================');
    console.log('  BioCloud IoT -> Direct GitHub Push Tool (Zero Git CLI Needed)');
    console.log('========================================================================');
    console.log('');
    console.log('Please provide your GitHub Username and Personal Access Token (PAT).');
    console.log('');
    console.log('How to get a GitHub Token (Takes 30 seconds):');
    console.log('1. Go to: https://github.com/settings/tokens');
    console.log('2. Click "Generate new token" -> "Generate new token (classic)"');
    console.log('3. Note: "BioCloud Project Push"');
    console.log('4. Check the box: [x] repo (Full control of private repositories)');
    console.log('5. Click "Generate token" and copy the token (starts with ghp_...)');
    console.log('');
    console.log('Then run this command:');
    console.log(`   node push_to_github.js YOUR_GITHUB_USERNAME YOUR_TOKEN [REPO_NAME]`);
    console.log('========================================================================');
    process.exit(1);
}

const ROOT_DIR = __dirname;
const IGNORE_LIST = [
    'node_modules',
    '.git',
    '.env',
    'dist',
    'logs',
    'Thumbs.db',
    '.DS_Store'
];

function githubRequest(endpoint, method, payload) {
    return new Promise((resolve, reject) => {
        const url = new URL(`https://api.github.com${endpoint}`);
        const data = payload ? JSON.stringify(payload) : null;

        const req = https.request({
            hostname: url.hostname,
            path: url.pathname + (url.search || ''),
            method: method,
            headers: {
                'User-Agent': 'BioCloud-GitHub-Pusher',
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                ...(data ? {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                } : {})
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(body); } catch (_) { parsed = body; }
                resolve({ status: res.statusCode, data: parsed });
            });
        });

        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

function getAllFiles(dir, baseDir = '') {
    let files = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        if (IGNORE_LIST.includes(entry.name) || entry.name.endsWith('.log')) continue;
        const fullPath = path.join(dir, entry.name);
        const relPath = path.join(baseDir, entry.name).replace(/\\/g, '/');

        if (entry.isDirectory()) {
            files = files.concat(getAllFiles(fullPath, relPath));
        } else if (entry.isFile()) {
            files.push({ fullPath, relPath });
        }
    }
    return files;
}

async function main() {
    console.log('========================================================================');
    console.log(`  Target GitHub Account: https://github.com/${username}`);
    console.log(`  Target Repository:     https://github.com/${username}/${repoName}`);
    console.log('========================================================================');

    // 1. Check or Create Repo
    console.log(`[1/3] Checking if repository '${repoName}' exists...`);
    let repoCheck = await githubRequest(`/repos/${username}/${repoName}`, 'GET');

    if (repoCheck.status === 404) {
        console.log(`Repository does not exist. Creating new public repository '${repoName}'...`);
        const createRes = await githubRequest('/user/repos', 'POST', {
            name: repoName,
            description: 'BioCloud IoT: Distributed Hybrid Edge-to-Cloud Healthcare Monitoring System (Cloud Computing Academic Project)',
            private: false,
            auto_init: false
        });

        if (createRes.status !== 201) {
            console.error('Failed to create repository:', createRes.data);
            process.exit(1);
        }
        console.log('Repository created successfully on GitHub!');
    } else if (repoCheck.status >= 200 && repoCheck.status < 300) {
        console.log('Repository found!');
    } else {
        console.error('Authentication or API error:', repoCheck.data);
        process.exit(1);
    }

    // 2. Collect project files
    console.log('[2/3] Collecting project files to upload...');
    const files = getAllFiles(ROOT_DIR);
    console.log(`Found ${files.length} project files to commit.`);

    // 3. Upload files sequentially
    console.log('[3/3] Uploading and committing files to main branch...');
    let successCount = 0;

    for (const file of files) {
        process.stdout.write(`  -> Uploading: ${file.relPath} ... `);
        const contentBase64 = fs.readFileSync(file.fullPath).toString('base64');

        // Check if file already exists to get SHA
        let sha = null;
        const existing = await githubRequest(`/repos/${username}/${repoName}/contents/${file.relPath}`, 'GET');
        if (existing.status === 200 && existing.data && existing.data.sha) {
            sha = existing.data.sha;
        }

        const putRes = await githubRequest(`/repos/${username}/${repoName}/contents/${file.relPath}`, 'PUT', {
            message: `Upload ${file.relPath} - BioCloud IoT`,
            content: contentBase64,
            ...(sha ? { sha } : {})
        });

        if (putRes.status === 200 || putRes.status === 201) {
            process.stdout.write('DONE\n');
            successCount++;
        } else {
            process.stdout.write(`FAILED (${putRes.status})\n`);
            console.error('     Error details:', putRes.data);
        }
    }

    console.log('');
    console.log('========================================================================');
    console.log(`  SUCCESS! Pushed ${successCount}/${files.length} files to GitHub!`);
    console.log(`  Live Repository URL: https://github.com/${username}/${repoName}`);
    console.log('========================================================================');
}

main().catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
});
