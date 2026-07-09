/**
 * LeetCode 43: Multiply Strings
 * 
 * Given two non-negative integers num1 and num2 represented as strings,
 * return the product of num1 and num2, also represented as a string.
 * 
 * Constraints:
 * - Cannot use built-in BigInteger library or direct integer conversion
 * - 1 <= num1.length, num2.length <= 200
 * - num1 and num2 consist of digits only
 * - num1 and num2 do not have leading zeros except for the number 0 itself
 * 
 * @param {string} num1 - First number as string
 * @param {string} num2 - Second number as string
 * @return {string} - Product as string
 */

function multiply(num1, num2) {
    // Handle edge case: if either number is 0, return "0"
    if (num1 === '0' || num2 === '0') {
        return '0';
    }
    
    const m = num1.length;
    const n = num2.length;
    
    // Result can have at most m + n digits
    const result = new Array(m + n).fill(0);
    
    // Multiply each digit and add to the result
    // Process from right to left (least significant to most significant)
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            // Get the digits
            const digit1 = parseInt(num1[i], 10);
            const digit2 = parseInt(num2[j], 10);
            
            // Calculate product
            const product = digit1 * digit2;
            
            // Positions in result array
            // The product affects positions i+j and i+j+1
            const pos1 = i + j;
            const pos2 = i + j + 1;
            
            // Add product to the result
            const sum = product + result[pos2];
            
            // Store the units digit at pos2
            result[pos2] = sum % 10;
            
            // Add carry to pos1
            result[pos1] += Math.floor(sum / 10);
        }
    }
    
    // Convert result array to string, skipping leading zeros
    let resultStr = '';
    for (let num of result) {
        // Skip leading zeros
        if (resultStr === '' && num === 0) {
            continue;
        }
        resultStr += num;
    }
    
    return resultStr;
}

// Alternative implementation using the standard grade-school algorithm
function multiplyAlternative(num1, num2) {
    if (num1 === '0' || num2 === '0') {
        return '0';
    }
    
    const m = num1.length;
    const n = num2.length;
    const result = new Array(m + n).fill(0);
    
    // Reverse both strings for easier processing
    const num1Rev = num1.split('').reverse().join('');
    const num2Rev = num2.split('').reverse().join('');
    
    // Multiply each digit
    for (let i = 0; i < m; i++) {
        for (let j = 0; j < n; j++) {
            const digit1 = parseInt(num1Rev[i], 10);
            const digit2 = parseInt(num2Rev[j], 10);
            result[i + j] += digit1 * digit2;
            
            // Handle carry
            if (result[i + j] >= 10) {
                result[i + j + 1] += Math.floor(result[i + j] / 10);
                result[i + j] %= 10;
            }
        }
    }
    
    // Handle final carry
    for (let i = m + n - 2; i >= 0; i--) {
        if (result[i] >= 10) {
            result[i + 1] += Math.floor(result[i] / 10);
            result[i] %= 10;
        }
    }
    
    // Convert to string, skipping leading zeros
    let resultStr = '';
    let startIdx = m + n - 1;
    
    // Find first non-zero digit from the end (most significant)
    while (startIdx >= 0 && result[startIdx] === 0) {
        startIdx--;
    }
    
    for (let i = startIdx; i >= 0; i--) {
        resultStr += result[i];
    }
    
    return resultStr;
}

// Test cases
console.log('Test cases:');
console.log(`multiply("2", "3") = "${multiply('2', '3')}"`); // Expected: "6"
console.log(`multiply("123", "456") = "${multiply('123', '456')}"`); // Expected: "56088"
console.log(`multiply("0", "123") = "${multiply('0', '123')}"`); // Expected: "0"
console.log(`multiply("999", "999") = "${multiply('999', '999')}"`); // Expected: "998001"

console.log('\nAlternative implementation:');
console.log(`multiplyAlternative("2", "3") = "${multiplyAlternative('2', '3')}"`);
console.log(`multiplyAlternative("123", "456") = "${multiplyAlternative('123', '456')}"`);

module.exports = { multiply, multiplyAlternative };
