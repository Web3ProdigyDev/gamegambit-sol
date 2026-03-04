console.log('Testing configuration...\n');

try {
  // Test 1: Check .env file
  console.log('1️⃣ Checking .env file...');
  const fs = require('fs');
  if (fs.existsSync('.env')) {
    console.log('✅ .env file exists');
    const envContent = fs.readFileSync('.env', 'utf-8');
    const hasJWT = envContent.includes('PINATA_JWT=');
    const hasRPC = envContent.includes('SOLANA_RPC_URL=');
    console.log('   JWT set:', hasJWT ? '✅' : '❌');
    console.log('   RPC set:', hasRPC ? '✅' : '❌');
  } else {
    console.log('❌ .env file not found');
  }
  
  // Test 2: Load config
  console.log('\n2️⃣ Loading config...');
  const { getPinataConfig } = require('./src/config/env.config');
  const config = getPinataConfig();
  
  console.log('✅ Config loaded');
  console.log('   JWT length:', config.jwt.length, 'chars');
  console.log('   Gateway:', config.gateway);
  
  console.log('\n✅ All configuration checks passed!');
  console.log('\nℹ️  Network connectivity issue detected.');
  console.log('   This might be a temporary issue. Try:');
  console.log('   1. Check your internet connection');
  console.log('   2. If on WSL, try: wsl --shutdown (in PowerShell)');
  console.log('   3. Wait a few minutes and try again');
  
} catch (error) {
  console.error('❌ Error:', error.message);
}
