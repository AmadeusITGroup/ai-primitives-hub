#!/usr/bin/env python3
"""Patch slide16.xml: remove right-side table shapes, inject bubble chart picture."""
import defusedxml.minidom as minidom
from xml.dom import minidom as dom_minidom
import re

SLIDE = "unpacked/ppt/slides/slide16.xml"

with open(SLIDE, "r", encoding="utf-8") as f:
    content = f.read()

# Parse
doc = minidom.parseString(content.encode("utf-8"))

# Namespaces
NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}

spTree = doc.getElementsByTagNameNS(NS["p"], "spTree")[0]

# IDs to remove: 37-62 (the right-side fastest-growing table)
ids_to_remove = set(str(i) for i in range(37, 63))

to_remove = []
for child in spTree.childNodes:
    if child.nodeType != child.ELEMENT_NODE:
        continue
    cNvPr_list = child.getElementsByTagNameNS(NS["p"], "cNvPr")
    if not cNvPr_list:
        # also check a: namespace (grpSp uses same)
        cNvPr_list = child.getElementsByTagName("p:cNvPr")
    if cNvPr_list:
        shape_id = cNvPr_list[0].getAttribute("id")
        if shape_id in ids_to_remove:
            to_remove.append(child)

print(f"Removing {len(to_remove)} shape nodes: {[n.getElementsByTagNameNS(NS['p'], 'cNvPr')[0].getAttribute('id') for n in to_remove]}")

for node in to_remove:
    spTree.removeChild(node)

# Build new picture element for the bubble chart
# Position: x=5917087 y=2432304  cx=5425085 cy=2900000
pic_xml = '''<p:pic xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
              xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
              xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:nvPicPr>
    <p:cNvPr id="70" name="BubbleChart 70"/>
    <p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>
    <p:nvPr/>
  </p:nvPicPr>
  <p:blipFill>
    <a:blip r:embed="rId5"/>
    <a:stretch><a:fillRect/></a:stretch>
  </p:blipFill>
  <p:spPr>
    <a:xfrm>
      <a:off x="5917087" y="2432304"/>
      <a:ext cx="5425085" cy="2600000"/>
    </a:xfrm>
    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
  </p:spPr>
</p:pic>'''

pic_doc = minidom.parseString(pic_xml.encode("utf-8"))
pic_node = doc.importNode(pic_doc.documentElement, True)
spTree.appendChild(pic_node)

# Serialize back
result = doc.toprettyxml(indent="  ", encoding="utf-8").decode("utf-8")
# toprettyxml adds <?xml ...?> header — keep it, remove extra blank lines
result = re.sub(r'\n\s*\n', '\n', result)

with open(SLIDE, "w", encoding="utf-8") as f:
    f.write(result)

print("Done patching slide16.xml")
