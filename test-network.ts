import axios from 'axios';

async function testNetwork() {
  console.log('Testing network connectivity...\n');
  
  try {
    // Test 1: Basic HTTP request
    console.log('1️⃣ Testing basic HTTP...');
    const response1 = await axios.get('https://httpbin.org/get');
    console.log('✅ Basic HTTP works');
    
    // Test 2: Pinata API
    console.log('\n2️⃣ Testing Pinata API...');
    const jwt = process.env.PINATA_JWT || 'your_jwt_here';
    
    const response2 = await axios.get('https://api.pinata.cloud/data/testAuthentication', {
      headers: {
        'Authorization': `Bearer ${jwt}`
      },
      timeout: 10000
    });
    
    console.log('✅ Pinata API works:', response2.data);
    
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    if (error.code) {
      console.error('Error code:', error.code);
    }
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
  }
}

testNetwork();
