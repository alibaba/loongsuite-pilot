//! Main #555: one bounded window, only newline-complete records are parsed.
//! An explicit oversize skip is persisted so a suffix is never parsed as a record.
use crate::inputs::base::{InputRuntime, InputRuntimeAccumulator};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

pub(crate) const LINE_TAIL_READ_BYTES: u64 = 16 * 1024 * 1024;

pub(crate) struct LineTail {
    pub bytes: Vec<u8>,
    pub offset: u64,
    pub skipping_line: bool,
    pub began_skip: bool,
}

pub(crate) async fn read_line_tail(
    file: &mut tokio::fs::File,
    size: u64,
    offset: u64,
    skipping_line: bool,
    rt: &InputRuntime,
) -> std::io::Result<LineTail> {
    let backlog = size.saturating_sub(offset);
    rt.with_accumulator(|acc| acc.observe_backlog(backlog));
    if backlog == 0 {
        return Ok(LineTail {
            bytes: Vec::new(),
            offset,
            skipping_line,
            began_skip: false,
        });
    }
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let requested = backlog.min(LINE_TAIL_READ_BYTES);
    let mut bytes = vec![0; requested as usize];
    let started = InputRuntimeAccumulator::now();
    let mut filled = 0;
    while filled < bytes.len() {
        let n = file.read(&mut bytes[filled..]).await?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    bytes.truncate(filled);
    rt.with_accumulator(|acc| {
        acc.observe_read(
            filled as u64,
            requested,
            InputRuntimeAccumulator::now() - started,
        )
    });
    let start = if skipping_line {
        match bytes.iter().position(|b| *b == b'\n') {
            Some(n) => n + 1,
            None => {
                return Ok(LineTail {
                    bytes: Vec::new(),
                    offset: offset + filled as u64,
                    skipping_line: true,
                    began_skip: false,
                })
            }
        }
    } else {
        0
    };
    if let Some(end) = bytes.iter().rposition(|b| *b == b'\n').map(|n| n + 1) {
        bytes.truncate(end);
        bytes.drain(..start);
        return Ok(LineTail {
            bytes,
            offset: offset + end as u64,
            skipping_line: false,
            began_skip: false,
        });
    }
    let began_skip = filled as u64 == LINE_TAIL_READ_BYTES;
    Ok(LineTail {
        bytes: Vec::new(),
        offset: if began_skip {
            offset + filled as u64
        } else {
            offset
        },
        skipping_line: began_skip,
        began_skip,
    })
}
