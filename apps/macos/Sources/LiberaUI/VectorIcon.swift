import SwiftUI

// The same Lucide 0.475 icon nodes used by React; ISC notice is bundled.
private struct IconNode: Decodable {
    let kind: String
    let attrs: [String: String]
    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        kind = try container.decode(String.self)
        attrs = try container.decode([String: String].self)
    }
    func number(_ key: String) -> CGFloat { CGFloat(Double(attrs[key] ?? "0") ?? 0) }
}
struct VectorIcon: View {
    let name: String
    private static let catalog = try! JSONDecoder().decode([String: [IconNode]].self,
        from: Data(contentsOf: Bundle.module.url(forResource: "icons", withExtension: "json", subdirectory: "Resources")!))
    var body: some View {
        Canvas { context, size in
            let scale = min(size.width, size.height) / 24
            context.scaleBy(x: scale, y: scale)
            for node in Self.catalog[name] ?? [] {
                var path = Path()
                switch node.kind {
                case "path": path = SVGPath(node.attrs["d"] ?? "").path
                case "line":
                    path.move(to: CGPoint(x: node.number("x1"), y: node.number("y1")))
                    path.addLine(to: CGPoint(x: node.number("x2"), y: node.number("y2")))
                case "rect":
                    path.addRoundedRect(in: CGRect(x: node.number("x"), y: node.number("y"), width: node.number("width"), height: node.number("height")), cornerSize: CGSize(width: node.number("rx"), height: node.number("rx")))
                case "circle":
                    let r = node.number("r")
                    path.addEllipse(in: CGRect(x: node.number("cx")-r, y: node.number("cy")-r, width: r*2, height: r*2))
                case "polyline", "polygon":
                    let values = (node.attrs["points"] ?? "").split { $0==" " || $0=="," }.compactMap { Double($0) }
                    for i in stride(from: 0, to: values.count-1, by: 2) {
                        let point = CGPoint(x: values[i], y: values[i+1])
                        if i==0 { path.move(to: point) } else { path.addLine(to: point) }
                    }
                    if node.kind=="polygon" { path.closeSubpath() }
                default: break
                }
                context.stroke(path, with: .foreground, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
        }.accessibilityHidden(true)
    }
}
private struct SVGPath {
    var path = Path()
    init(_ source: String) {
        let expression = try! NSRegularExpression(pattern: "[A-Za-z]|[-+]?(?:[0-9]*\\.)?[0-9]+(?:[eE][-+]?[0-9]+)?")
        let range = NSRange(source.startIndex..., in: source)
        let tokens = expression.matches(in: source, range: range).map { String(source[Range($0.range, in: source)!]) }
        var i=0, command="M", point=CGPoint.zero, start=CGPoint.zero
        func number() -> CGFloat { defer { i+=1 }; return CGFloat(Double(tokens[i]) ?? 0) }
        while i<tokens.count {
            if tokens[i].first!.isLetter { command=tokens[i];i+=1 }
            let relative = command == command.lowercased()
            let origin = relative ? point : .zero
            func nextPoint() -> CGPoint { CGPoint(x: number()+origin.x, y: number()+origin.y) }
            switch command.uppercased() {
            case "M": point=nextPoint();path.move(to:point);start=point;command=relative ? "l" : "L"
            case "L": point=nextPoint();path.addLine(to:point)
            case "H": point.x=number()+origin.x;path.addLine(to:point)
            case "V": point.y=number()+origin.y;path.addLine(to:point)
            case "C": let c1=nextPoint(), c2=nextPoint();point=nextPoint();path.addCurve(to:point,control1:c1,control2:c2)
            case "Q": let c=nextPoint();point=nextPoint();path.addQuadCurve(to:point,control:c)
            case "A":
                let rx=number(),ry=number(),rotation=number(),large=number()>0,sweep=number()>0
                let end=nextPoint(); Self.arc(&path,from:point,to:end,rx:rx,ry:ry,rotation:rotation,large:large,sweep:sweep);point=end
            case "Z": path.closeSubpath();point=start;command="M"
            default: return
            }
        }
    }
    // SVG endpoint arcs converted into cubic curves, preserving the source icon.
    private static func arc(_ path: inout Path, from: CGPoint, to: CGPoint, rx: CGFloat, ry: CGFloat, rotation: CGFloat, large: Bool, sweep: Bool) {
        if rx==0 || ry==0 { path.addLine(to:to);return }
        if from==to { return }
        var rx=abs(rx),ry=abs(ry)
        let phi=rotation * .pi/180,cosPhi=cos(phi),sinPhi=sin(phi)
        let dx=(from.x-to.x)/2,dy=(from.y-to.y)/2
        let xp=cosPhi*dx+sinPhi*dy,yp = -sinPhi*dx+cosPhi*dy
        let lambda=xp*xp/(rx*rx)+yp*yp/(ry*ry)
        if lambda>1 { let scale=sqrt(lambda);rx*=scale;ry*=scale }
        let numerator=max(0,rx*rx*ry*ry-rx*rx*yp*yp-ry*ry*xp*xp)
        let denominator=rx*rx*yp*yp+ry*ry*xp*xp
        let factor=(large==sweep ? -1.0 : 1.0)*sqrt(numerator/denominator)
        let cxp=factor*rx*yp/ry,cyp = -factor*ry*xp/rx
        let cx=cosPhi*cxp-sinPhi*cyp+(from.x+to.x)/2,cy=sinPhi*cxp+cosPhi*cyp+(from.y+to.y)/2
        let start=atan2((yp-cyp)/ry,(xp-cxp)/rx)
        var delta=atan2((-yp-cyp)/ry,(-xp-cxp)/rx)-start
        if sweep && delta<0 { delta+=2 * .pi };if !sweep && delta>0 { delta-=2 * .pi }
        let count=max(1,Int(ceil(abs(delta)/(.pi/2)))),step=delta/CGFloat(count)
        func transform(_ x: CGFloat,_ y: CGFloat)->CGPoint { CGPoint(x:cx+cosPhi*rx*x-sinPhi*ry*y,y:cy+sinPhi*rx*x+cosPhi*ry*y) }
        for i in 0..<count {
            let a=start+CGFloat(i)*step,b=a+step,t=4/3*tan(step/4)
            path.addCurve(to:transform(cos(b),sin(b)),control1:transform(cos(a)-t*sin(a),sin(a)+t*cos(a)),control2:transform(cos(b)+t*sin(b),sin(b)-t*cos(b)))
        }
    }
}
