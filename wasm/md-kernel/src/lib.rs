//! md-kernel：长文档虚拟化高度索引内核。
//!
//! Fenwick 树维护各块实测/估算高度的前缀和，
//! 供渲染器以 O(log n) 定位滚动窗口（替代 O(n) 线性扫描）。
//! 纯数值、零外部依赖，`extern "C"` 直出（无需 wasm-bindgen），
//! 字节序/对齐由 f64 数组保证，调用方（TS）通过 WebAssembly 内存无关。

#![allow(static_mut_refs)]

/// Fenwick 树（1-based；TREE[0] 恒为 0）
static mut TREE: Vec<f64> = Vec::new();
/// 最高二进制位（二分下降用）
static mut LOGN: usize = 0;

unsafe fn prefix(x: usize) -> f64 {
    let mut s = 0.0;
    let mut x = x;
    while x > 0 {
        s += TREE[x];
        x -= x & x.wrapping_neg();
    }
    s
}

/// 初始化容量为 n 的索引（全部高度置 0，随后 mdk_update 逐块填充）
#[no_mangle]
pub extern "C" fn mdk_init(n: i32) {
    let n = n.max(0) as usize;
    unsafe {
        TREE = vec![0.0; n + 1];
        let mut log: usize = 1;
        while (log << 1) <= n {
            log <<= 1;
        }
        LOGN = log;
    }
}

/// 块 i 高度变化 delta（新值 - 旧值）
#[no_mangle]
pub extern "C" fn mdk_update(i: i32, delta: f64) {
    unsafe {
        let n = TREE.len() - 1;
        if n == 0 {
            return;
        }
        let mut x = (i.max(0) as usize) + 1;
        if x > n {
            return;
        }
        while x <= n {
            TREE[x] += delta;
            x += x & x.wrapping_neg();
        }
    }
}

/// 定位：前缀和 ≤ v 的最大块数（即视口上/下边界处的块下标，0-based 排他）
#[no_mangle]
pub extern "C" fn mdk_query(v: f64) -> i32 {
    unsafe {
        let n = TREE.len() - 1;
        if n == 0 {
            return 0;
        }
        let mut pos = 0usize;
        let mut rem = v;
        let mut bitmask = LOGN;
        while bitmask != 0 {
            let np = pos + bitmask;
            if np <= n {
                let val = TREE[np];
                if rem >= val {
                    pos = np;
                    rem -= val;
                }
            }
            bitmask >>= 1;
        }
        pos as i32
    }
}

/// 全部高度总和
#[no_mangle]
pub extern "C" fn mdk_total() -> f64 {
    unsafe {
        let n = TREE.len() - 1;
        if n == 0 {
            return 0.0;
        }
        prefix(n)
    }
}

/// 单块当前高度（对拍/调试用）
#[no_mangle]
pub extern "C" fn mdk_height_at(i: i32) -> f64 {
    unsafe {
        let i = i.max(0) as usize;
        let n = TREE.len() - 1;
        if i >= n {
            return 0.0;
        }
        prefix(i + 1) - prefix(i)
    }
}
