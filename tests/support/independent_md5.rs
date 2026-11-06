// Test-only oracle. No call into loongsuite_pilot or its MD5 implementation.
// RFC 1321 section 3: https://www.rfc-editor.org/rfc/rfc1321
// Constants are derived from sin rather than shared with the production table.
// Expected vectors below were produced offline by Node node:crypto, not this code.
pub fn digest_hex(message: &[u8]) -> String {
    const ORDER: [[usize; 16]; 4] = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        [1, 6, 11, 0, 5, 10, 15, 4, 9, 14, 3, 8, 13, 2, 7, 12],
        [5, 8, 11, 14, 1, 4, 7, 10, 13, 0, 3, 6, 9, 12, 15, 2],
        [0, 7, 14, 5, 12, 3, 10, 1, 8, 15, 6, 13, 4, 11, 2, 9],
    ];
    const ROTATIONS: [[u32; 4]; 4] = [
        [7, 12, 17, 22],
        [5, 9, 14, 20],
        [4, 11, 16, 23],
        [6, 10, 15, 21],
    ];
    let padded_bytes = (message.len() + 9).div_ceil(64) * 64;
    let mut padded = vec![0_u8; padded_bytes];
    padded[..message.len()].copy_from_slice(message);
    padded[message.len()] = 0x80;
    padded[padded_bytes - 8..]
        .copy_from_slice(&(message.len() as u64).wrapping_mul(8).to_le_bytes());
    let mut state = [0x6745_2301_u32, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476];
    for block in padded.as_chunks::<64>().0 {
        let words: Vec<_> = block
            .as_chunks::<4>()
            .0
            .iter()
            .map(|bytes| u32::from_le_bytes(*bytes))
            .collect();
        let mut registers = state;
        for phase in 0..4 {
            for operation in 0..16 {
                let [a, b, c, d] = registers;
                let function = match phase {
                    0 => d ^ (b & (c ^ d)),
                    1 => c ^ (d & (b ^ c)),
                    2 => b ^ c ^ d,
                    3 => c ^ (b | !d),
                    _ => unreachable!(),
                };
                let ordinal = (phase * 16 + operation + 1) as f64;
                let constant = (ordinal.sin().abs() * 4_294_967_296.0).floor() as u64;
                let sum = u64::from(a)
                    + u64::from(function)
                    + u64::from(words[ORDER[phase][operation]])
                    + constant;
                let word = sum as u32;
                let shift = ROTATIONS[phase][operation % 4];
                let rotated = word.rotate_left(shift);
                registers = [d, (u64::from(b) + u64::from(rotated)) as u32, b, c];
            }
        }
        for (accumulator, word) in state.iter_mut().zip(registers) {
            *accumulator = (u64::from(*accumulator) + u64::from(word)) as u32;
        }
    }
    const HEX: &[u8] = b"0123456789ABCDEF";
    let mut digest = String::with_capacity(32);
    for byte in state.into_iter().flat_map(u32::to_le_bytes) {
        digest.push(HEX[(byte >> 4) as usize] as char);
        digest.push(HEX[(byte & 15) as usize] as char);
    }
    digest
}

#[test]
fn matches_offline_node_crypto_for_padding_boundaries_multiblock_binary_and_utf8() {
    let utf8_cases: &[(&str, &str)] = &[
        ("", "D41D8CD98F00B204E9800998ECF8427E"),
        ("a", "0CC175B9C0F1B6A831C399E269772661"),
        ("abc", "900150983CD24FB0D6963F7D28E17F72"),
        ("message digest", "F96B697D7CB7938D525A2F31AAF161D0"),
        (
            "abcdefghijklmnopqrstuvwxyz",
            "C3FCD3D76192E4007DFB496CCA67E13B",
        ),
        (
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
            "D174AB98D277D9F5A5611C2C9F419D9F",
        ),
        (
            "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
            "57EDF4A22BE3C955AC49DA2E2107B67A",
        ),
        (
            "{\"gen_ai.session.id\":\"会话😀\",\"source\":\"127.0.0.1\"}",
            "9190C5D4A9008BF3E99859A0C3A9C76D",
        ),
    ];
    for &(input, expected) in utf8_cases {
        assert_eq!(digest_hex(input.as_bytes()), expected, "{input:?}");
    }
    let binary_cases: &[(usize, usize, &str)] = &[
        (1, 1, "55A54008AD1BA589AA210D2629C1DF41"),
        (55, 55, "2AA2821B45586F2047AF1787DAAD2549"),
        (56, 56, "685C5A1EB242D13676768F26BB843560"),
        (57, 57, "1714EC0374B545FCBB8E5AC725DC916B"),
        (63, 63, "C1711BC6F5001667C70354CDC4CC3992"),
        (64, 64, "A030BCD3707563D2A6E7A81EFBDAD71A"),
        (65, 65, "260A5A59CA321B107CEBBD1131486E02"),
        (119, 119, "1F4E492EAD19026711B811C84EB876E9"),
        (120, 120, "60E252C60E446F2962C086AA60294A99"),
        (127, 127, "4B86E5A04298DD8B9EF4BAC99B1C98D6"),
        (128, 128, "FBA206E4A830D9E566FE7CD67041CE89"),
        (129, 129, "86D6B145ECD9B228823CEC1CC09C48DE"),
        (255, 4, "AAF172AD8E2B7BC2C339930196039687"),
        (256, 5, "857F4223C137B9304B8D0A4E8178FBB3"),
        (1024, 20, "D95B70AAED496B27D0D63D5F85530B17"),
        (4096, 80, "A76D7D44E8AFB1A18EC36D09796F0C66"),
        (65537, 26, "0FFE233C9EC613CEC04B29A136811E3F"),
    ];
    for &(length, seed, expected) in binary_cases {
        let input: Vec<_> = (0..length)
            .map(|index| ((index * 73 + seed) % 256) as u8)
            .collect();
        assert_eq!(digest_hex(&input), expected, "length={length}, seed={seed}");
    }
}
