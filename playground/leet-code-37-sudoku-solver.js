/**
 * LeetCode 37: Sudoku Solver
 * 
 * Solves a Sudoku puzzle by filling the empty cells.
 * 
 * Rules:
 * 1. Each digit 1-9 must appear only once per row
 * 2. Each digit 1-9 must appear only once per column
 * 3. Each digit 1-9 must appear only once per 3x3 sub-box
 * 
 * @param {character[][]} board - 9x9 Sudoku board where '.' represents empty cells
 * @returns {void} - Modifies the board in-place
 */
function solveSudoku(board) {
    // Track which numbers are already used in each row, column, and box
    const rows = Array.from({ length: 9 }, () => new Set());
    const cols = Array.from({ length: 9 }, () => new Set());
    const boxes = Array.from({ length: 9 }, () => new Set());
    
    // Initialize the tracking sets with existing numbers
    for (let i = 0; i < 9; i++) {
        for (let j = 0; j < 9; j++) {
            if (board[i][j] !== '.') {
                const num = board[i][j];
                const boxIndex = Math.floor(i / 3) * 3 + Math.floor(j / 3);
                rows[i].add(num);
                cols[j].add(num);
                boxes[boxIndex].add(num);
            }
        }
    }
    
    // Backtracking function to fill empty cells
    function backtrack(row, col) {
        // Base case: if we've processed all cells
        if (row === 9) {
            return true;
        }
        
        // Calculate next position
        let nextRow = row;
        let nextCol = col + 1;
        if (nextCol === 9) {
            nextRow = row + 1;
            nextCol = 0;
        }
        
        // If current cell is already filled, move to next cell
        if (board[row][col] !== '.') {
            return backtrack(nextRow, nextCol);
        }
        
        // Try digits 1-9
        const boxIndex = Math.floor(row / 3) * 3 + Math.floor(col / 3);
        
        for (let num = 1; num <= 9; num++) {
            const numStr = num.toString();
            
            // Check if this number is valid in current position
            if (!rows[row].has(numStr) && 
                !cols[col].has(numStr) && 
                !boxes[boxIndex].has(numStr)) {
                
                // Place the number
                board[row][col] = numStr;
                rows[row].add(numStr);
                cols[col].add(numStr);
                boxes[boxIndex].add(numStr);
                
                // Recursively solve the rest
                if (backtrack(nextRow, nextCol)) {
                    return true;
                }
                
                // Backtrack: remove the number if it didn't lead to a solution
                board[row][col] = '.';
                rows[row].delete(numStr);
                cols[col].delete(numStr);
                boxes[boxIndex].delete(numStr);
            }
        }
        
        // No valid number found, need to backtrack
        return false;
    }
    
    // Start backtracking from top-left cell
    backtrack(0, 0);
}

// Test case
const board1 = [
    ['5', '3', '.', '.', '7', '.', '.', '.', '.'],
    ['6', '.', '.', '1', '9', '5', '.', '.', '.'],
    ['.', '9', '8', '.', '.', '.', '.', '6', '.'],
    ['8', '.', '.', '.', '6', '.', '.', '.', '3'],
    ['4', '.', '.', '8', '.', '3', '.', '.', '1'],
    ['7', '.', '.', '.', '2', '.', '.', '.', '6'],
    ['.', '6', '.', '.', '.', '.', '2', '8', '.'],
    ['.', '.', '.', '4', '1', '9', '.', '.', '5'],
    ['.', '.', '.', '.', '8', '.', '.', '7', '9']
];

console.log('Before solving:');
console.log(board1.map(row => row.join(' ')).join('\n'));

solveSudoku(board1);

console.log('\nAfter solving:');
console.log(board1.map(row => row.join(' ')).join('\n'));

// Expected output:
// 5 3 4 | 6 7 8 | 9 1 2
// 6 7 2 | 1 9 5 | 3 4 8
// 1 9 8 | 3 4 2 | 5 6 7
// 8 5 9 | 7 6 1 | 4 2 3
// 4 2 6 | 8 5 3 | 7 9 1
// 7 1 3 | 9 2 4 | 8 5 6
// 9 6 1 | 5 3 7 | 2 8 4
// 2 8 7 | 4 1 9 | 6 3 5
// 3 4 5 | 2 8 6 | 1 7 9
