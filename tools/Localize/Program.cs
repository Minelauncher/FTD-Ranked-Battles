using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using System.Text.Json;
using System.Text.RegularExpressions;
var sources = Directory.GetFiles(args[0], "*.cs");
var rewrite = new Translate();
foreach (var path in sources.OrderBy(p => p)) {
 if (Path.GetFileName(path) is "Language.cs" or "LanguageFlags.cs") continue;
 var tree = CSharpSyntaxTree.ParseText(File.ReadAllText(path));
 var updated = rewrite.Visit(tree.GetRoot());
 if (args.Contains("--write")) File.WriteAllText(path, updated.ToFullString());
}
File.WriteAllText(args[1], JsonSerializer.Serialize(rewrite.Keys.ToArray(), new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
class Translate : CSharpSyntaxRewriter {
 public HashSet<string> Keys = new();
 static bool Korean(string value) => Regex.IsMatch(value, "[가-힣]");
 static string Lit(string value) => SyntaxFactory.Literal(value).ToString();
 public override SyntaxNode VisitLiteralExpression(LiteralExpressionSyntax node) {
  if (!node.IsKind(SyntaxKind.StringLiteralExpression) || !Korean(node.Token.ValueText)) return base.VisitLiteralExpression(node);
  if (node.Ancestors().OfType<InvocationExpressionSyntax>().Any(i => i.Expression.ToString() is "L.T" or "L.F")) return node;
  Keys.Add(node.Token.ValueText);
  return SyntaxFactory.ParseExpression("L.T(" + Lit(node.Token.ValueText) + ")").WithTriviaFrom(node);
 }
 public override SyntaxNode VisitInterpolatedStringExpression(InterpolatedStringExpressionSyntax node) {
  if (!node.Contents.OfType<InterpolatedStringTextSyntax>().Any(t => Korean(t.TextToken.ValueText))) return base.VisitInterpolatedStringExpression(node);
  string template = ""; var values = new List<string>();
  foreach (var part in node.Contents) {
   if (part is InterpolatedStringTextSyntax text) template += text.TextToken.ValueText;
   else if (part is InterpolationSyntax field) {
    template += "{" + values.Count + (field.AlignmentClause?.ToString() ?? "") + (field.FormatClause?.ToString() ?? "") + "}";
    values.Add(Visit(field.Expression).ToString());
   }
  }
  Keys.Add(template);
  return SyntaxFactory.ParseExpression("L.F(" + Lit(template) + ", " + string.Join(", ", values) + ")").WithTriviaFrom(node);
 }
}
