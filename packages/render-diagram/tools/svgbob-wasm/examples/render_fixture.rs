fn main() {
    let out = std::env::args().nth(1).expect("usage: render_fixture <out.svg>");
    std::fs::write(out, svgbob::to_svg("+-->+\n| a |\n+<--+\n")).expect("write fixture");
}
