#!/usr/bin/env node
/**
 * MaxMind GeoLite2 数据库自动更新脚本
 * 
 * 功能：
 * - 从 MaxMind 下载最新的 GeoLite2-City.mmdb 数据库
 * - 自动替换旧数据库文件
 * - 支持手动触发和定时任务
 * 
 * 使用方法：
 *   npm run update-geolite2
 *   或
 *   npx tsx scripts/update-geolite2.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { fileURLToPath } from 'url';
import { config } from '../src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// MaxMind GeoLite2 下载 URL
const GEOLITE2_DOWNLOAD_URL = 'https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key={LICENSE_KEY}&suffix=tar.gz';

async function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    
    https.get(url, (response) => {
      if (response.statusCode === 200) {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      } else if (response.statusCode === 401) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error('Invalid license key. Please check your MAXMIND_LICENSE_KEY.'));
      } else {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`Download failed with status code ${response.statusCode}`));
      }
    }).on('error', (err) => {
      file.close();
      if (fs.existsSync(dest)) {
        fs.unlinkSync(dest);
      }
      reject(err);
    });
  });
}

async function extractTarGz(tarGzPath: string, extractDir: string): Promise<string> {
  // 注意：Node.js 原生不支持 tar.gz 解压
  // 使用系统命令解压（tar 或 7z）
  
  const { execSync } = await import('child_process');
  const os = await import('os');
  const platform = os.platform();
  
  try {
    // 根据平台选择解压命令
    if (platform === 'win32') {
      // Windows: 使用 7z 或 tar（Windows 10+ 内置 tar）
      try {
        execSync(`tar -xzf "${tarGzPath}" -C "${extractDir}"`, { stdio: 'inherit' });
      } catch {
        // 如果 tar 失败，尝试 7z
        execSync(`7z x "${tarGzPath}" -o"${extractDir}"`, { stdio: 'inherit' });
      }
    } else {
      // Linux/Mac: 使用 tar
      execSync(`tar -xzf "${tarGzPath}" -C "${extractDir}"`, { stdio: 'inherit' });
    }
    
    // 递归查找解压后的 .mmdb 文件
    function findMmdbFile(dir: string): string | null {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = findMmdbFile(fullPath);
          if (found) return found;
        } else if (entry.name.endsWith('GeoLite2-City.mmdb')) {
          return fullPath;
        }
      }
      return null;
    }
    
    const mmdbFile = findMmdbFile(extractDir);
    if (!mmdbFile) {
      throw new Error('GeoLite2-City.mmdb not found in extracted archive');
    }
    
    return mmdbFile;
  } catch (error: any) {
    console.error('❌ Failed to extract tar.gz.');
    console.error('💡 Please ensure you have one of the following installed:');
    console.error('   - tar (Linux/Mac, or Windows 10+)');
    console.error('   - 7z (Windows, if tar is not available)');
    throw error;
  }
}

async function updateGeoLite2Database(): Promise<void> {
  try {
    // 检查 License Key
    if (!config.maxmindLicenseKey) {
      throw new Error('MAXMIND_LICENSE_KEY environment variable is required. Please set it in your .env file.');
    }

    console.log('🚀 Starting GeoLite2 database update...');

    // 创建 data 目录（如果不存在）
    const dataDir = path.resolve(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
      console.log(`📁 Created data directory: ${dataDir}`);
    }

    // 下载 URL
    const downloadUrl = GEOLITE2_DOWNLOAD_URL.replace('{LICENSE_KEY}', config.maxmindLicenseKey);
    
    // 临时文件路径
    const tempDir = path.join(dataDir, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const tarGzPath = path.join(tempDir, 'GeoLite2-City.tar.gz');
    const finalDbPath = path.resolve(config.maxmindDbPath);

    console.log('📥 Downloading GeoLite2-City database...');
    await downloadFile(downloadUrl, tarGzPath);
    console.log('✅ Download completed');

    console.log('📦 Extracting archive...');
    const extractedDbPath = await extractTarGz(tarGzPath, tempDir);
    console.log('✅ Extraction completed');

    // 备份旧数据库（如果存在）
    if (fs.existsSync(finalDbPath)) {
      const backupPath = `${finalDbPath}.backup.${Date.now()}`;
      fs.copyFileSync(finalDbPath, backupPath);
      console.log(`💾 Backed up old database to: ${backupPath}`);
    }

    // 移动新数据库到目标位置
    fs.copyFileSync(extractedDbPath, finalDbPath);
    console.log(`✅ Database updated: ${finalDbPath}`);

    // 清理临时文件
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('🧹 Cleaned up temporary files');

    // 检查文件大小
    const stats = fs.statSync(finalDbPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`📊 Database size: ${sizeMB} MB`);

    console.log('🎉 GeoLite2 database update completed successfully!');
  } catch (error: any) {
    console.error('❌ Failed to update GeoLite2 database:', error?.message || error);
    throw error;
  }
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  updateGeoLite2Database()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

// 导出函数供其他模块使用
export { updateGeoLite2Database };

