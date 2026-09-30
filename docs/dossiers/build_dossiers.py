# Dossiers de validation (cybersécurité, protection des données) : Markdown → PDF.
#   python docs/dossiers/build_dossiers.py
# Source : docs/dossiers/*.md (à modifier librement) ; PDF écrits dans docs/.
# Conventions de mise en page : docs/dossiers/README.md.
# Le contenu décrit l'état du code à la date indiquée : à relire et régénérer à chaque
# changement de flux de données, de stockage, d'authentification ou de bibliothèque tierce.
import math
import re
import sys
from pathlib import Path

from reportlab.graphics import renderSVG
from reportlab.graphics.shapes import Drawing, Line, Polygon, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import (KeepTogether, ListFlowable, ListItem, Paragraph, SimpleDocTemplate,
                                Spacer, Table, TableStyle)

HERE = Path(__file__).resolve().parent
OUT = HERE.parent

# ── Polices et styles ──────────────────────────────────────────────────────
FONTS = Path('C:/Windows/Fonts')
pdfmetrics.registerFont(TTFont('Sans', str(FONTS / 'segoeui.ttf')))
pdfmetrics.registerFont(TTFont('Sans-Bold', str(FONTS / 'segoeuib.ttf')))
pdfmetrics.registerFont(TTFont('Sans-Semi', str(FONTS / 'seguisb.ttf')))
pdfmetrics.registerFont(TTFont('Sans-Light', str(FONTS / 'segoeuisl.ttf')))
pdfmetrics.registerFontFamily('Sans', normal='Sans', bold='Sans-Bold', italic='Sans-Light', boldItalic='Sans-Bold')

INK = colors.HexColor('#1d1d1f')
MUTED = colors.HexColor('#5f6368')
LINE = colors.HexColor('#d9d9de')
SOFT = colors.HexColor('#f3f3f5')
RED = colors.HexColor('#e2001a')   # rouge EPFL, en accent seulement
RED_SOFT = colors.HexColor('#fdecee')

S = {
    'title': ParagraphStyle('title', fontName='Sans-Bold', fontSize=22, leading=27, textColor=INK, spaceAfter=4),
    'subtitle': ParagraphStyle('subtitle', fontName='Sans-Light', fontSize=13, leading=18, textColor=MUTED, spaceAfter=14),
    'h1': ParagraphStyle('h1', fontName='Sans-Bold', fontSize=14, leading=18, textColor=INK, spaceBefore=16, spaceAfter=6, keepWithNext=1),
    'h2': ParagraphStyle('h2', fontName='Sans-Semi', fontSize=11.5, leading=15, textColor=INK, spaceBefore=10, spaceAfter=4, keepWithNext=1),
    'p': ParagraphStyle('p', fontName='Sans', fontSize=10, leading=14.5, textColor=INK, spaceAfter=6, alignment=TA_LEFT),
    'small': ParagraphStyle('small', fontName='Sans', fontSize=8.5, leading=11.5, textColor=MUTED, spaceAfter=6),
    'cell': ParagraphStyle('cell', fontName='Sans', fontSize=8.8, leading=11.8, textColor=INK),
    'cellb': ParagraphStyle('cellb', fontName='Sans-Semi', fontSize=8.8, leading=11.8, textColor=INK),
    'head': ParagraphStyle('head', fontName='Sans-Semi', fontSize=8.8, leading=11.8, textColor=INK),
    'mono': ParagraphStyle('mono', fontName='Courier', fontSize=7.4, leading=9.5, textColor=INK),
    'callout': ParagraphStyle('callout', fontName='Sans', fontSize=10, leading=14.5, textColor=INK),
}
WIDTH = A4[0] - 40 * mm


def P(text, style='p'):
    # Espace insécable avant « ; : ? » et à l'intérieur des guillemets français.
    for a, b in ((' ;', '\u00a0;'), (' :', '\u00a0:'), (' ?', '\u00a0?'), ('« ', '«\u00a0'), (' »', '\u00a0»')):
        text = text.replace(a, b)
    return Paragraph(text, S[style])


# ── Blocs de mise en page ──────────────────────────────────────────────────
def bullets(items):
    return ListFlowable([ListItem(P(t), leftIndent=12, value='•') for t in items],
                        bulletType='bullet', start='•', leftIndent=12, bulletFontName='Sans', bulletFontSize=9, spaceAfter=6)


def numbered(items):
    return ListFlowable([ListItem(P(t), leftIndent=16) for t in items], bulletType='1', leftIndent=16,
                        bulletFontName='Sans-Semi', bulletFontSize=9.5, spaceAfter=6)


def table(data, widths, header=True):
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    cmds = [
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LINEBELOW', (0, 0), (-1, -1), 0.5, LINE),
        ('TOPPADDING', (0, 0), (-1, -1), 4.5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('LEFTPADDING', (0, 0), (-1, -1), 5),
        ('RIGHTPADDING', (0, 0), (-1, -1), 5),
    ]
    if header:
        cmds += [('BACKGROUND', (0, 0), (-1, 0), SOFT), ('LINEBELOW', (0, 0), (-1, 0), 0.8, INK)]
    else:
        cmds += [('LINEABOVE', (0, 0), (-1, 0), 0.8, INK)]
    t.setStyle(TableStyle(cmds))
    return t


def callout(text):
    t = Table([[P(text, 'callout')]], colWidths=[WIDTH])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), RED_SOFT),
        ('LINEBEFORE', (0, 0), (0, -1), 3, RED),
        ('LEFTPADDING', (0, 0), (-1, -1), 10), ('RIGHTPADDING', (0, 0), (-1, -1), 10),
        ('TOPPADDING', (0, 0), (-1, -1), 8), ('BOTTOMPADDING', (0, 0), (-1, -1), 9),
    ]))
    return t


def decision_box(title, options):
    """Encadré à remplir par l'instance qui valide."""
    box = lambda: Table([['']], colWidths=[9], rowHeights=[9], style=[('BOX', (0, 0), (-1, -1), 0.8, INK)])
    rows = [[box(), P(o)] for o in options]
    choices = Table(rows, colWidths=[16, WIDTH - 36], style=[('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                                                            ('LEFTPADDING', (0, 0), (-1, -1), 0),
                                                            ('TOPPADDING', (0, 0), (-1, -1), 2)])
    lines = Table([[P('Conditions / remarques :', 'cellb')], [''], [''], [''],
                   [P('Nom, fonction, date :', 'cellb')], ['']],
                  colWidths=[WIDTH - 20], rowHeights=[15, 20, 20, 20, 17, 20],
                  style=[('LINEBELOW', (0, 1), (-1, 3), 0.4, LINE), ('LINEBELOW', (0, 5), (-1, 5), 0.4, LINE),
                         ('LEFTPADDING', (0, 0), (-1, -1), 0)])
    t = Table([[P(title, 'h2')], [choices], [lines]], colWidths=[WIDTH])
    t.setStyle(TableStyle([('BOX', (0, 0), (-1, -1), 0.8, INK), ('LEFTPADDING', (0, 0), (-1, -1), 10),
                           ('RIGHTPADDING', (0, 0), (-1, -1), 10), ('TOPPADDING', (0, 0), (-1, -1), 4),
                           ('BOTTOMPADDING', (0, 0), (-1, -1), 6)]))
    return KeepTogether([Spacer(1, 6), t])


# ── Schéma des flux (image « schema-flux.svg » dans les .md) ───────────────
def flow_diagram():
    W, H = WIDTH, 250
    d = Drawing(W, H)
    bw, bh = 158, 62

    def box(x, y, title, lines, fill=colors.white):
        d.add(Rect(x, y, bw, bh, rx=6, ry=6, fillColor=fill, strokeColor=INK, strokeWidth=0.9))
        d.add(String(x + 10, y + bh - 17, title, fontName='Sans-Semi', fontSize=9.5, fillColor=INK))
        for i, l in enumerate(lines):
            d.add(String(x + 10, y + bh - 32 - i * 11.5, l, fontName='Sans', fontSize=8, fillColor=MUTED))

    def arrow(x1, y1, x2, y2, both=False):
        d.add(Line(x1, y1, x2, y2, strokeColor=INK, strokeWidth=1.1))

        def head(xa, ya, xb, yb):
            a = math.atan2(yb - ya, xb - xa)
            L, w = 7, 3.5
            p1 = (xb - L * math.cos(a) + w * math.sin(a), yb - L * math.sin(a) - w * math.cos(a))
            p2 = (xb - L * math.cos(a) - w * math.sin(a), yb - L * math.sin(a) + w * math.cos(a))
            d.add(Polygon([xb, yb, *p1, *p2], fillColor=INK, strokeColor=INK, strokeWidth=0.5))
        head(x1, y1, x2, y2)
        if both:
            head(x2, y2, x1, y1)

    def label(x, y, lines, size=7.8, color=INK):
        for i, l in enumerate(lines):
            d.add(String(x, y - i * 10.5, l, fontName='Sans', fontSize=size, fillColor=color))

    # Cadre « infrastructure EPFL »
    d.add(Rect(0, 0, W, H, rx=8, ry=8, fillColor=None, strokeColor=LINE, strokeWidth=0.8, strokeDashArray=[4, 3]))
    d.add(String(10, H - 14, 'Tout est hébergé à l\u2019EPFL', fontName='Sans-Semi', fontSize=8, fillColor=MUTED))

    top, bottom = H - 26 - bh, 14
    left, right = 12, W - 12 - bw
    box(left, top, 'Navigateur de l\u2019usager', ['page sesame.epfl.ch (session SSO)', 'favori + script ndf.js', 'images décodées et réduites ici'],
        fill=RED_SOFT)
    box(right, top, 'Serveur notes-de-frais', ['expert-finder.epfl.ch/notes-de-frais', 'Kubernetes EPFL, 1 conteneur', 'stockage : compteurs d’usage'])
    box(left, bottom, 'SAP sesame', ['My Travel and Expenses', 'API OData PAOC_TRV_SRV', '(celle de l\u2019application Fiori)'])
    box(right, bottom, 'Plateforme IA RCP', ['inference.rcp.epfl.ch', 'modèle GLM-5.3-Flash', '(poids ouverts, exécuté à l\u2019EPFL)'])

    # Navigateur ↔ serveur
    ya = top + bh - 22
    arrow(left + bw, ya, right, ya)
    label(left + bw + 10, ya + 16, ['images réduites', '+ liste des types de frais'])
    yb = top + 16
    arrow(right, yb, left + bw, yb)
    label(left + bw + 10, yb - 12, ['script et décodeurs,', 'champs lus par le modèle'])
    # Navigateur ↔ SAP
    xl = left + 34
    arrow(xl, top, xl, bottom + bh, both=True)
    label(xl + 8, top - 14, ['avec les droits de l\u2019usager :', 'lecture profil, fonds,', 'approbateurs, notes existantes ;',
                             'création du brouillon', '+ pièces jointes'])
    # Serveur ↔ RCP
    xr = right + bw - 34
    arrow(xr, top, xr, bottom + bh, both=True)
    label(xr - 112, top - 14, ['image + consigne fixe', 'clé RCP du serveur', '\u2192 champs en JSON'])
    # Message central
    label(left + bw + 12, bottom + 30, ['Aucune donnée SAP', 'n\u2019est envoyée au serveur.'], size=8, color=RED)
    return d


def write_diagram_svg(path):
    """Même schéma en SVG, pour l'aperçu des .md (polices remplacées par celles du système)."""
    renderSVG.drawToFile(flow_diagram(), str(path))
    svg = path.read_text(encoding='utf-8')
    svg = re.sub(r'font-family\s*[:=]\s*"?Sans-Semi"?', 'font-family: Segoe UI, system-ui, sans-serif; font-weight: 600', svg)
    svg = re.sub(r'font-family\s*[:=]\s*"?Sans"?', 'font-family: Segoe UI, system-ui, sans-serif', svg)
    path.write_text(svg, encoding='utf-8')


IMAGES = {'schema-flux.svg': flow_diagram}


# ── Markdown → flowables ───────────────────────────────────────────────────
def inline(md):
    """Sous-ensemble Markdown d'une ligne → balisage ReportLab."""
    codes = []

    def keep_code(m):
        s = m.group(1)
        # Longue empreinte sans espace : coupée en lignes de 32 caractères.
        if len(s) > 40 and ' ' not in s:
            s = '<br/>'.join(s[i:i + 32] for i in range(0, len(s), 32))
            codes.append(f'<font name="Courier" size="7.4">{s}</font>')
        else:
            codes.append(f'<font name="Courier" size="8.8">{esc(s)}</font>')
        return f'\x00{len(codes) - 1}\x00'

    text = md.replace('\\*', '\x01').replace('\\|', '|')
    text = re.sub(r'`([^`]+)`', keep_code, text)
    text = esc(text).replace('&lt;br&gt;', '<br/>').replace('&lt;br/&gt;', '<br/>')
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'\1', text)
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])', r'<i>\1</i>', text)
    text = re.sub('\x00(\\d+)\x00', lambda m: codes[int(m.group(1))], text)
    return text.replace('\x01', '*')


def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def front_matter(text):
    meta = {}
    m = re.match(r'---\r?\n(.*?)\r?\n---\r?\n', text, re.S)
    if not m:
        return meta, text
    for line in m.group(1).splitlines():
        k, _, v = line.partition(':')
        meta[k.strip()] = v.strip().strip('"\'')
    return meta, text[m.end():]


def split_row(line):
    return [c.strip() for c in re.split(r'(?<!\\)\|', line.strip().strip('|'))]


def md_table(lines):
    rows = [split_row(l) for l in lines]
    sep = rows[1]
    dashes = [max(1, len(c.replace(':', ''))) for c in sep]
    widths = [WIDTH * d / sum(dashes) for d in dashes]
    header = any(c for c in rows[0])   # en-tête vide = tableau « fiche » (Responsable, Date…)
    body = rows[2:]
    data = []
    if header:
        data.append([P(inline(c.replace('**', '')), 'head') for c in rows[0]])
    for r in body:
        cells = []
        for c in r:
            m = re.fullmatch(r'`([^`]+)`', c)
            cells.append(P(inline(c), 'mono') if m else P(inline(c), 'cell'))
        data.append(cells)
    return table(data, widths, header=header)


def blocks(body):
    """Découpe le Markdown en blocs (titre, paragraphe, liste, tableau…)."""
    lines = body.splitlines()
    i, out = 0, []
    while i < len(lines):
        line = lines[i]
        s = line.strip()
        if not s:
            i += 1
        elif s.startswith('<!--'):
            while '-->' not in lines[i]:
                i += 1
            i += 1
        elif s.startswith('#'):
            level = len(s) - len(s.lstrip('#'))
            out.append((f'h{level}', s[level:].strip()))
            i += 1
        elif s.startswith('|'):
            tbl = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                tbl.append(lines[i])
                i += 1
            out.append(('table', tbl))
        elif s.startswith('>'):
            q = []
            while i < len(lines) and lines[i].strip().startswith('>'):
                q.append(lines[i].strip()[1:].strip())
                i += 1
            out.append(('callout', ' '.join(q)))
        elif re.match(r'!\[[^\]]*\]\(([^)]+)\)$', s):
            out.append(('image', re.match(r'!\[[^\]]*\]\(([^)]+)\)$', s).group(1)))
            i += 1
        elif re.match(r'(\d+\.|-|\*) ', s):
            kind = 'ol' if s[0].isdigit() else ('tasks' if re.match(r'[-*] \[[ xX]\] ', s) else 'ul')
            items = []
            while i < len(lines):
                t = lines[i]
                if re.match(r'\s*(\d+\.|-|\*) ', t) and not t.startswith('  '):
                    items.append(re.sub(r'^\s*(\d+\.|-|\*) (\[[ xX]\] )?', '', t).strip())
                elif t.startswith('  ') and t.strip() and items:
                    items[-1] += ' ' + t.strip()   # suite de l'élément sur la ligne suivante
                else:
                    break
                i += 1
            out.append((kind, items))
        else:
            para = []
            while i < len(lines) and lines[i].strip() and not re.match(r'\s*(#|\||>|!\[|\d+\. |- |\* |<!--)', lines[i]):
                para.append(lines[i].strip())
                i += 1
            out.append(('p', ' '.join(para)))
    return out


def story_from(md_blocks):
    story = []
    prev = None
    for kind, val in md_blocks:
        if kind == 'h1':
            story.append(P(inline(val), 'title'))
        elif kind == 'p' and prev == 'h1' and re.fullmatch(r'\*[^*].*\*', val):
            story.append(P(inline(val[1:-1]), 'subtitle'))
        elif kind == 'h2':
            story.append(P(inline(val), 'h1'))
        elif kind in ('h3', 'h4'):
            story.append(P(inline(val), 'h2'))
        elif kind == 'p':
            m = re.fullmatch(r'<small>(.*)</small>', val)
            story.append(P(inline(m.group(1)), 'small') if m else P(inline(val)))
        elif kind == 'callout':
            story += [callout(inline(val)), Spacer(1, 8)]
        elif kind == 'ul':
            story.append(bullets([inline(t) for t in val]))
        elif kind == 'ol':
            story.append(numbered([inline(t) for t in val]))
        elif kind == 'tasks':
            # Cases à cocher : encadré d'avis, titré par l'intertitre qui précède.
            title = 'Avis'
            if prev in ('h2', 'h3') and story:
                title = story.pop().text
            story.append(decision_box(title, [inline(t) for t in val]))
        elif kind == 'table':
            story += [md_table(val), Spacer(1, 6)]
        elif kind == 'image':
            name = Path(val).name
            if name not in IMAGES:
                sys.exit(f'image non prise en charge : {val} (seules : {", ".join(IMAGES)})')
            story += [IMAGES[name](), Spacer(1, 8)]
        prev = kind
    return story


# ── Mise en page : en-tête, pied, « page x / y » ───────────────────────────
def numbered_canvas(header, footer):
    class NumberedCanvas(rl_canvas.Canvas):
        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            self._saved = []

        def showPage(self):
            self._saved.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            n = len(self._saved)
            for state in self._saved:
                self.__dict__.update(state)
                self._decorate(n)
                super().showPage()
            super().save()

        def _decorate(self, n):
            w, h = A4
            self.setFont('Sans', 7.8)
            self.setFillColor(MUTED)
            self.drawString(20 * mm, h - 12 * mm, header)
            self.drawRightString(w - 20 * mm, h - 12 * mm, 'Usage interne EPFL')
            self.setStrokeColor(LINE)
            self.setLineWidth(0.5)
            self.line(20 * mm, h - 13.5 * mm, w - 20 * mm, h - 13.5 * mm)
            self.drawString(20 * mm, 11 * mm, footer)
            self.drawRightString(w - 20 * mm, 11 * mm, f'page {self._pageNumber} / {n}')
            if self._pageNumber == 1:
                self.setFillColor(RED)
                self.rect(20 * mm, h - 24 * mm, 14 * mm, 1.6 * mm, stroke=0, fill=1)
    return NumberedCanvas


def build(md_path):
    meta, body = front_matter(md_path.read_text(encoding='utf-8'))
    pdf = OUT / meta.get('pdf', md_path.with_suffix('.pdf').name)
    header = meta.get('en-tete', md_path.stem)
    footer = f"Version {meta.get('version', '?')} \u2014 {meta.get('date', '?')}"
    doc = SimpleDocTemplate(str(pdf), pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm,
                            topMargin=26 * mm, bottomMargin=20 * mm, title=header.replace('\u2014', '-'),
                            author=meta.get('auteur', ''), subject=meta.get('sujet', ''))
    doc.build(story_from(blocks(body)), canvasmaker=numbered_canvas(header, footer))
    print('écrit :', pdf.relative_to(OUT.parent))


if __name__ == '__main__':
    write_diagram_svg(HERE / 'schema-flux.svg')
    for md in sorted(HERE.glob('*.md')):
        if md.name.lower() != 'readme.md':
            build(md)
