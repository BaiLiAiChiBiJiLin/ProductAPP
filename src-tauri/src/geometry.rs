#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Matrix { pub a: f64, pub b: f64, pub c: f64, pub d: f64, pub e: f64, pub f: f64 }
pub const DEFAULT_TOLERANCE: f64 = 0.1;

#[allow(dead_code)]
impl Matrix {
    pub const IDENTITY: Self = Self { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 };
    pub fn multiply(self, o: Self) -> Self { Self { a: self.a*o.a+self.c*o.b, b: self.b*o.a+self.d*o.b, c: self.a*o.c+self.c*o.d, d: self.b*o.c+self.d*o.d, e: self.a*o.e+self.c*o.f+self.e, f: self.b*o.e+self.d*o.f+self.f } }
    pub fn point(self, x: f64, y: f64) -> (f64, f64) { (self.a*x+self.c*y+self.e, self.b*x+self.d*y+self.f) }
    pub fn bounds(self, x: f64, y: f64, w: f64, h: f64) -> [f64; 4] { let p=[self.point(x,y),self.point(x+w,y),self.point(x,y+h),self.point(x+w,y+h)]; [p.iter().map(|p|p.0).fold(f64::INFINITY,f64::min),p.iter().map(|p|p.1).fold(f64::INFINITY,f64::min),p.iter().map(|p|p.0).fold(f64::NEG_INFINITY,f64::max),p.iter().map(|p|p.1).fold(f64::NEG_INFINITY,f64::max)] }
    pub fn nearly_same(a: [f64;4], b: [f64;4], tolerance: f64) -> bool { a.iter().zip(b).all(|(x,y)| (x-y).abs() <= tolerance) }
}

#[allow(dead_code)]
pub fn parse_transform(value: &str) -> Matrix {
    let mut result = Matrix::IDENTITY;
    for part in value.split(')').filter_map(|p| p.split_once('(')) {
        let nums: Vec<f64> = part.1.replace(',', " ").split_whitespace().filter_map(|v| v.parse().ok()).collect();
        let name = part.0.trim();
        let m = match name {
            "translate" => Matrix { a:1.0,b:0.0,c:0.0,d:1.0,e:nums.first().copied().unwrap_or(0.0),f:nums.get(1).copied().unwrap_or(0.0) },
            "scale" => { let x=nums.first().copied().unwrap_or(1.0); Matrix { a:x,b:0.0,c:0.0,d:nums.get(1).copied().unwrap_or(x),e:0.0,f:0.0 } },
            "rotate" => { let r=nums.first().copied().unwrap_or(0.0).to_radians(); let (s,c)=(r.sin(),r.cos()); Matrix { a:c,b:s,c:-s,d:c,e:0.0,f:0.0 } },
            "matrix" if nums.len() >= 6 => Matrix { a:nums[0],b:nums[1],c:nums[2],d:nums[3],e:nums[4],f:nums[5] },
            _ => Matrix::IDENTITY,
        };
        result = result.multiply(m);
    }
    result
}

/// Accumulate transforms from the SVG root down to an element.
#[allow(dead_code)]
pub fn ancestor_transform(node: roxmltree::Node<'_, '_>) -> Matrix {
    let mut chain = Vec::new();
    let mut current = Some(node);
    while let Some(item) = current { chain.push(item.attribute("transform").map(parse_transform).unwrap_or(Matrix::IDENTITY)); current = item.parent(); }
    chain.into_iter().rev().fold(Matrix::IDENTITY, |acc, m| acc.multiply(m))
}

#[cfg(test)]
mod tests { use super::*; #[test] fn transforms_corners(){ let m=Matrix{a:0.0,b:1.0,c:-1.0,d:0.0,e:10.0,f:20.0}; assert_eq!(m.bounds(0.0,0.0,2.0,3.0),[7.0,20.0,10.0,22.0]); } #[test] fn tolerance(){ assert!(Matrix::nearly_same([1.0,2.0,3.0,4.0],[1.05,2.0,3.0,4.0],DEFAULT_TOLERANCE)); assert!(!Matrix::nearly_same([1.0,2.0,3.0,4.0],[1.2,2.0,3.0,4.0],DEFAULT_TOLERANCE)); } }
