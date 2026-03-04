import * as fs from 'fs';
import axios from 'axios';
import FormData from 'form-data';

async function uploadDiamond() {
  console.log('💎 Uploading Diamond Trophy...\n');

  const files = [
    './trophies/diamond.png',
    './trophies/diamond.jpg',
    './tropies/diamond.png',
    './tropies/diamond.jpg',
  ];

  let filePath = null;
  for (const file of files) {
    if (fs.existsSync(file)) {
      filePath = file;
      console.log('✅ Found:', file);
      break;
    }
  }

  if (!filePath) {
    console.log('❌ Diamond trophy not found!');
    console.log('\nLooked in:');
    files.forEach(f => console.log('  -', f));
    console.log('\nPlease move your diamond image to: ./trophies/diamond.png');
    return;
  }

  try {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(filePath));
    formData.append('pinataMetadata', JSON.stringify({ name: 'diamond_trophy.png' }));
    formData.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

    const jwt = process.env.PINATA_JWT;
    
    const response = await axios.post(
      'https://api.pinata.cloud/pinning/pinFileToIPFS',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${jwt}`,
          ...formData.getHeaders(),
        },
        maxBodyLength: Infinity,
      }
    );

    const hash = response.data.IpfsHash;
    const uri = `https://gateway.pinata.cloud/ipfs/${hash}`;

    console.log('\n✅ Diamond trophy uploaded!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('IPFS URI:', uri);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // Update trophy-uris.json
    const configPath = './src/config/trophy-uris.json';
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    config.diamond = uri;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('\n💾 Updated:', configPath);
    
    console.log('\n📝 Now update trophy-gallery.html with this URI:');
    console.log(`   Replace the diamond img src with: ${uri}`);

  } catch (error: any) {
    console.error('❌ Upload failed:', error.message);
  }
}

uploadDiamond();
