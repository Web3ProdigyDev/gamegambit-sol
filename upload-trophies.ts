import { pinataService } from './src/services/pinata.service';
import * as fs from 'fs';
import * as path from 'path';

async function uploadTrophies() {
  console.log('🎨 Uploading trophy images to Pinata...\n');

  const trophies = [
    { name: 'bronze', file: './trophies/bronze.png' },
    { name: 'silver', file: './trophies/silver.png' },
    { name: 'gold', file: './trophies/gold.png' },
    { name: 'diamond', file: './trophies/diamond.png' },
  ];

  const uploaded: Record<string, string> = {};

  for (const trophy of trophies) {
    try {
      if (!fs.existsSync(trophy.file)) {
        console.log(`⚠️  File not found: ${trophy.file}`);
        continue;
      }

      console.log(`📤 Uploading ${trophy.name}...`);
      
      const fileBuffer = fs.readFileSync(trophy.file);
      const hash = await uploadImageBuffer(fileBuffer, `${trophy.name}_trophy.png`);
      const uri = `https://gateway.pinata.cloud/ipfs/${hash}`;
      
      uploaded[trophy.name] = uri;
      console.log(`✅ ${trophy.name}: ${uri}\n`);
      
    } catch (error: any) {
      console.error(`❌ Failed to upload ${trophy.name}:`, error.message);
    }
  }

  // Save URIs to a config file
  const configPath = './src/config/trophy-uris.json';
  fs.writeFileSync(configPath, JSON.stringify(uploaded, null, 2));
  console.log(`\n💾 Trophy URIs saved to: ${configPath}`);
  console.log('\n🎉 Upload complete!');
  console.log('\nYour trophy URIs:');
  console.log(JSON.stringify(uploaded, null, 2));
}

async function uploadImageBuffer(buffer: Buffer, fileName: string): Promise<string> {
  const axios = require('axios');
  const FormData = require('form-data');
  const { getPinataConfig } = require('./src/config/env.config');
  
  const config = getPinataConfig();
  const formData = new FormData();
  
  formData.append('file', buffer, { filename: fileName, contentType: 'image/png' });
  formData.append('pinataMetadata', JSON.stringify({ name: fileName }));
  formData.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

  const response = await axios.post(
    'https://api.pinata.cloud/pinning/pinFileToIPFS',
    formData,
    {
      headers: {
        'Authorization': `Bearer ${config.jwt}`,
        ...formData.getHeaders(),
      },
      maxBodyLength: Infinity,
    }
  );

  return response.data.IpfsHash;
}

uploadTrophies();
