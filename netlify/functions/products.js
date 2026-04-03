// netlify/functions/products.js
// Endpoint GET para que la web pueda leer los productos.

const fs   = require('fs');
const path = require('path');

const PRODUCTS_PATH = path.join(__dirname, '../../data/products.json');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: ''
    };
  }

  try {
    const raw  = fs.readFileSync(PRODUCTS_PATH, 'utf8');
    const data = JSON.parse(raw);
    return {
      statusCode: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    };
  } catch {
    return {
      statusCode: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ products: [] })
    };
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };
}
